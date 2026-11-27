#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:/opt/cargo/bin:$HOME/.avm/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OWNER_KEY=".devnet-keys/owner-devnet.json"
AGENT_KEY=".devnet-keys/agent-devnet.json"

if [[ ! -f "$OWNER_KEY" || ! -f "$AGENT_KEY" ]]; then
  echo "Error: Missing .devnet-keys/owner-devnet.json or .devnet-keys/agent-devnet.json" >&2
  exit 1
fi

OWNER_PUB=$(solana-keygen pubkey "$OWNER_KEY")
AGENT_PUB=$(solana-keygen pubkey "$AGENT_KEY")
echo "Owner / Deployer Pubkey: $OWNER_PUB"
echo "Agent Signer Pubkey:     $AGENT_PUB"

if [[ ! -f "target/deploy/leash.so" ]]; then
  anchor build
fi

if [[ ! -f "target/deploy/leash-keypair.json" ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o target/deploy/leash-keypair.json
fi

PROG_ID=$(solana-keygen pubkey target/deploy/leash-keypair.json)
echo "Target Program ID:       $PROG_ID"

# Sync Program ID across Anchor.toml, programs/leash/src/lib.rs, and app/src/lib/leash-idl.json if changed
if ! grep -q "$PROG_ID" programs/leash/src/lib.rs; then
  echo "Syncing Program ID $PROG_ID across codebase and rebuilding..."
  sed -i -E "s/declare_id!\(\"[A-Za-z0-9]+\"\);/declare_id!(\"$PROG_ID\");/" programs/leash/src/lib.rs
  sed -i -E "s/^leash = \"[A-Za-z0-9]+\"/leash = \"$PROG_ID\"/g" Anchor.toml
  anchor build
  if [[ -f "app/src/lib/leash-idl.json" ]]; then
    cp target/idl/leash.json app/src/lib/leash-idl.json
  fi
fi

echo "Deploying leash to Solana Devnet..."
anchor deploy --provider.cluster devnet --provider.wallet "$OWNER_KEY"

echo "Transferring 0.5 SOL from owner to agent if needed and running Devnet smoke suite..."
AGENT_SOL=$(solana balance "$AGENT_PUB" --url devnet | awk '{print $1}')
if awk "BEGIN {exit !($AGENT_SOL < 0.2)}"; then
  solana transfer "$AGENT_PUB" 0.5 --from "$OWNER_KEY" --url devnet --allow-unfunded-recipient
fi

npm run devnet:smoke
echo "Devnet deployment and smoke verification complete!"
