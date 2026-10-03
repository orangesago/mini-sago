"""Install the pinned gh-image binary without a GitHub login."""

import hashlib
from pathlib import Path
import sys
from urllib.request import urlopen


VERSION = "v1.4.0"
CHECKSUMS = {
    "amd64": "1ac03c3ae4784c4d0636edf42e7ce4d5532417d2808fe79733485c077538fa93",
    "arm64": "59e2370a444b0d7b554768a64073ce17ad92249036cc52a7dc7f767d72693287",
}

architecture = sys.argv[1]
checksum = CHECKSUMS[architecture]
url = f"https://github.com/drogers0/gh-image/releases/download/{VERSION}/linux-{architecture}"
with urlopen(url, timeout=60) as response:
    binary = response.read()
if hashlib.sha256(binary).hexdigest() != checksum:
    raise RuntimeError("gh-image checksum mismatch")
destination = Path("/usr/local/bin/gh-image")
destination.write_bytes(binary)
destination.chmod(0o755)
