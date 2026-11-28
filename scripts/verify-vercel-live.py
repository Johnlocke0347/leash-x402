#!/usr/bin/env python3
"""
One-command live Vercel (or staging) verifier & Step-2 submission screenshotter
for Leash — Solana x402 Circuit Breaker.

Usage:
  python3 scripts/verify-vercel-live.py --url https://your-app.vercel.app [--strict-green]
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

EXPECTED_PROGRAM_ID = "Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH"


def find_chromium_executable() -> str | None:
    for candidate in (
        os.environ.get("CHROME_BIN"),
        "/usr/bin/google-chrome",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def fetch_status_diagnostics(base_url: str) -> dict:
    status_url = f"{base_url.rstrip('/')}/api/status"
    req = urllib.request.Request(
        status_url,
        headers={"Accept": "application/json", "Cache-Control": "no-cache"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GET {status_url} failed with HTTP {exc.code}: {body}"
        ) from exc


def print_and_check_status_table(status: dict, strict_green: bool) -> None:
    program_id = status.get("programId")
    rpc_mode = status.get("rpcMode")
    faucet = status.get("faucet") or {}
    faucet_cfg = bool(faucet.get("configured"))
    faucet_bal = faucet.get("balanceSol")
    faucet_pk = faucet.get("pubkey") or "—"
    replay_store = status.get("replayStore")
    mint_policy = (status.get("mintPolicy") or {}).get("mode")

    checks = [
        (
            "Program ID",
            program_id == EXPECTED_PROGRAM_ID,
            f"{program_id}",
            f"Must equal {EXPECTED_PROGRAM_ID}",
        ),
        (
            "Custom Devnet RPC",
            rpc_mode == "custom_rpc",
            f"rpcMode={rpc_mode}",
            "Set SOLANA_RPC_URL + NEXT_PUBLIC_SOLANA_RPC_URL",
        ),
        (
            "Funded Server Faucet",
            faucet_cfg and (faucet_bal is None or float(faucet_bal) >= 0.06),
            f"configured={faucet_cfg}, balanceSol={faucet_bal}, pubkey={faucet_pk[:10]}...",
            "Set FAUCET_SECRET_KEY with >= 0.06 Devnet SOL",
        ),
        (
            "Atomic Upstash Replay",
            replay_store == "upstash_redis",
            f"replayStore={replay_store}",
            "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_*)",
        ),
        (
            "Sandbox MockUSDC Policy",
            mint_policy == "sandbox_mock_mint",
            f"mintPolicy.mode={mint_policy}",
            "Set ALLOW_SANDBOX_MOCK_MINT=true on Judge Sandbox",
        ),
    ]

    print("\n=== /api/status PRODUCTION READINESS TABLE ===")
    print(f"{'Check':<26} | {'Result':<6} | {'Observed Value'}")
    print("-" * 88)
    failures = []
    for label, passed, observed, hint in checks:
        verdict = "PASS" if passed else "FAIL"
        print(f"{label:<26} | {verdict:<6} | {observed}")
        if not passed:
            failures.append(f"{label}: {observed} ({hint})")
    print("-" * 88)

    if program_id != EXPECTED_PROGRAM_ID:
        raise RuntimeError(f"Program ID mismatch: {program_id}")

    if strict_green and failures:
        raise RuntimeError(
            "Strict green readiness check failed:\n  - " + "\n  - ".join(failures)
        )


def wait_step_done(page, step_btn_id: str, timeout_ms: int = 115_000) -> None:
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        tag_text = page.locator(f"#{step_btn_id} .step-tag").inner_text().strip()
        if tag_text == "DONE":
            return
        first_card = page.locator("#protocol-trace-list .trace-card").first
        if first_card.count() > 0:
            badge = first_card.locator(".http-pill").inner_text().strip()
            if "ERROR" in badge:
                raw = first_card.locator(".trace-pre").inner_text()
                raise RuntimeError(f"{step_btn_id} failed with {badge}: {raw}")
        page.wait_for_timeout(600)
    raise TimeoutError(f"Timed out waiting for {step_btn_id} to reach DONE")


def is_expected_protocol_console_log(txt: str, location_url: str) -> bool:
    if (
        "Failed to load resource: the server responded with a status of 402" in txt
        and "/api/x402/resource" in location_url
    ):
        return True
    if "429" in txt and ("solana.com" in location_url or "Retrying after" in txt):
        return True
    return False


def scroll_element_near_top(page, selector: str, top_margin_px: int = 16) -> None:
    page.evaluate(
        """([sel, margin]) => {
            const tl = document.querySelector('#protocol-trace-list');
            if (tl) tl.scrollTop = 0;
            const el = document.querySelector(sel);
            if (!el) {
                window.scrollTo(0, 0);
                return;
            }
            const rect = el.getBoundingClientRect();
            const targetY = Math.max(0, window.scrollY + rect.top - margin);
            window.scrollTo(0, targetY);
        }""",
        [selector, top_margin_px],
    )
    page.wait_for_timeout(350)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify live Vercel deployment of Leash x402 Sandbox & capture 4 submission screenshots."
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Target deployment URL (e.g. https://leash-x402.vercel.app)",
    )
    parser.add_argument(
        "--strict-green",
        action="store_true",
        help="Fail immediately if /api/status is missing custom_rpc, funded faucet, upstash_redis, or sandbox_mock_mint.",
    )
    parser.add_argument(
        "--out-dir",
        default=os.path.join(os.getcwd(), "docs", "screenshots"),
        help="Output directory for the 4 PNG screenshots (default: docs/screenshots)",
    )
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    status_data = fetch_status_diagnostics(base_url)
    print_and_check_status_table(status_data, strict_green=args.strict_green)

    unexpected_console_errors: list[str] = []
    page_errors: list[str] = []
    hydration_warnings: list[str] = []

    chrome_exec = find_chromium_executable()
    launch_kwargs: dict = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-dev-shm-usage"],
    }
    if chrome_exec:
        launch_kwargs["executable_path"] = chrome_exec

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        def on_console(msg):
            txt = msg.text
            loc = (msg.location or {}).get("url", "")
            if msg.type == "error" and not is_expected_protocol_console_log(txt, loc):
                unexpected_console_errors.append(f"{txt} [{loc}]")
            if "hydration" in txt.lower() or "did not match" in txt.lower():
                hydration_warnings.append(txt)

        def on_page_error(err):
            page_errors.append(str(err))

        page.on("console", on_console)
        page.on("pageerror", on_page_error)

        print(f"\nLaunching headless Chromium (1440x900) -> {base_url}")
        page.goto(base_url, wait_until="networkidle", timeout=60_000)

        # Wait for client keypairs & /api/status hydration
        page.wait_for_function(
            """() => {
                const addrs = document.querySelectorAll('.wallet-addr');
                const pill = document.querySelector('#pill-program-id');
                return addrs.length >= 2 && !addrs[0].textContent.includes('Initializing') && pill;
            }""",
            timeout=20_000,
        )

        # Screenshot 1: Tight element screenshot of ONLY the red-vs-green SVG architecture card
        arch_card = page.locator("#architecture-diagram-section")
        arch_card.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shot1 = os.path.join(out_dir, "01-architecture-diagram.png")
        arch_card.screenshot(path=shot1)
        print(f"[1/4] Saved tight architecture card -> {shot1}")

        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(200)

        # Step 1: Setup Demo Vault & Session
        print("Executing Step 1: Setup Demo Vault & Session...")
        page.click("#btn-step-1-setup")
        wait_step_done(page, "btn-step-1-setup", timeout_ms=120_000)
        badge_1 = page.locator("#session-status-badge").inner_text().strip()
        assert badge_1.upper() == "ACTIVE", f"Expected ACTIVE after Step 1, got {badge_1}"

        # Step 2: Normal x402 Payment (402 -> Pay -> 200 OK)
        print("Executing Step 2: Normal x402 Payment (402 -> 200 OK)...")
        page.click("#btn-step-2-pay")
        wait_step_done(page, "btn-step-2-pay", timeout_ms=100_000)
        bal_2 = page.locator("#val-vault-balance").inner_text().strip()
        assert "9.75" in bal_2, f"Expected 9.75 MockUSDC after Step 2, got {bal_2}"

        # Step 3: Replay Same Receipt (Single-Use Guard -> HTTP 402)
        print("Executing Step 3: Replay Same Receipt (Single-Use Guard)...")
        page.click("#btn-step-3-replay")
        wait_step_done(page, "btn-step-3-replay", timeout_ms=40_000)

        # Refresh /api/status pill after faucet drip so balance is current
        page.click("#btn-refresh-state")
        page.wait_for_timeout(500)

        # Screenshot 2: Top status bar (all pills) + Step 2 HTTP 200 OK + Step 3 HTTP 402 replay rejection
        scroll_element_near_top(page, ".status-strip", top_margin_px=14)
        shot2 = os.path.join(out_dir, "02-live-settled-and-replay.png")
        page.screenshot(path=shot2, full_page=False)
        print(f"[2/4] Saved settled 200 + replay 402 -> {shot2}")

        # Step 4: Inject Prompt-Injection Drain (Soft-Trip, 0 Moved)
        print("Executing Step 4: Inject Prompt-Injection Drain (Soft-Trip)...")
        page.click("#btn-step-4-drain")
        wait_step_done(page, "btn-step-4-drain", timeout_ms=100_000)
        badge_4 = page.locator("#session-status-badge").inner_text().strip()
        bal_4 = page.locator("#val-vault-balance").inner_text().strip()
        assert "TRIPPED" in badge_4.upper() and "EXCEEDSPERTXMAX" in badge_4.upper()
        assert "9.75" in bal_4, f"Expected 0 tokens moved on drain (9.75), got {bal_4}"

        # Step 5: Salami Retry After Trip (Hard-Reverts Custom(6010))
        print("Executing Step 5: Salami Retry After Trip (Hard-Reverts)...")
        page.click("#btn-step-5-salami")
        wait_step_done(page, "btn-step-5-salami", timeout_ms=100_000)

        # Screenshot 3: TRIPPED · EXCEEDSPERTXMAX state card + 0 moved + Step 5 Custom(6010) hard-revert
        scroll_element_near_top(page, ".right-column .card", top_margin_px=18)
        shot3 = os.path.join(out_dir, "03-circuit-breaker-tripped.png")
        page.screenshot(path=shot3, full_page=False)
        print(f"[3/4] Saved circuit breaker tripped -> {shot3}")

        # Step 6: Permissionless Reap Idle / Tripped Session
        print("Executing Step 6: Permissionless Reap Session...")
        page.click("#btn-step-6-reap")
        wait_step_done(page, "btn-step-6-reap", timeout_ms=100_000)
        badge_6 = page.locator("#session-status-badge").inner_text().strip()
        assert "REAPED" in badge_6.upper(), f"Expected REAPED badge, got {badge_6}"

        # Screenshot 4: BOTH the REAPED (RENT RETURNED) state card AND Step 6 trace entry clearly visible
        scroll_element_near_top(page, ".right-column .card", top_margin_px=18)
        shot4 = os.path.join(out_dir, "04-session-reaped.png")
        page.screenshot(path=shot4, full_page=False)
        print(f"[4/4] Saved session reaped + trace -> {shot4}")

        browser.close()

    if unexpected_console_errors:
        raise RuntimeError(f"Console errors detected: {unexpected_console_errors}")
    if page_errors:
        raise RuntimeError(f"Page errors detected: {page_errors}")
    if hydration_warnings:
        raise RuntimeError(f"Hydration warnings detected: {hydration_warnings}")

    print("\n=== LIVE VERIFICATION & 4 SCREENSHOTS COMPLETED SUCCESSFULLY ===")
    print("  - Console Errors:    0")
    print("  - Page Errors:       0")
    print("  - Hydration Warns:   0")
    print(f"  - Screenshots Saved: {out_dir}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
