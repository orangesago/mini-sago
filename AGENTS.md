# Deployment network settings

When deploying from a Mac through Tailscale:

- Keep exit-node routing disabled on the `sago-cream.github` profile. Never set
  `--exit-node=auto:any` on this profile, including when restoring settings after
  deployment. Automatic exit-node routing can disconnect the Mac from the internet.
- Inspect the selected profile and preferences before making network changes.
  With `sago-cream.github` selected and disconnected, use
  `tailscale set --exit-node=` to clear its exit-node selection before connecting.
- Preserve the separate NTHUSA profile's NAS exit-node preference. Do not apply
  the personal profile's settings to NTHUSA or hardcode machine-local profile IDs.
- Restore the original selected profile and connected/disconnected state after
  deployment, while leaving exit-node routing disabled on `sago-cream.github`.
  If the user asks to stay disconnected, do not connect to diagnose or test.

See [the deployment runbook](docs/operations.md#sago-cloud-deployment) for manual
setup. The Oracle deployment socket does not require changing Mac network settings.
