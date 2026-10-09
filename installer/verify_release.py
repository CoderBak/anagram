"""Verify a release's Sigstore bundle before anything of the release is used.

A release is signed by .github/workflows/release.yml, run in GitHub Actions at the release's
tag, and by nothing else: Sigstore keyless signing names that workflow, its repository and
the tag in a certificate the public log records. install.sh and install.ps1 carry this file
(scripts/sigstoreLock.mjs copies it in) and run it with sigstore-python, installed with every
file's hash pinned, before they open the archive:

    python -I verify_release.py ARCHIVE BUNDLE [VERSION]

It prints the version the signature names and exits 0, or says why not and exits 1. VERSION,
when given, is the one asked for, and the signature must name it. Sigstore's trust root is
brought up to date where its update server answers, and is otherwise the one sigstore-python
carries (where that server cannot be reached, as in mainland China).
"""
import base64
import hashlib
import json
import logging
import os
import re
import sys
import tempfile

SIGNER = "https://github.com/CoderBak/anagram/.github/workflows/release.yml@refs/tags/v"
ISSUER = "https://token.actions.githubusercontent.com"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def signers(bundle_json):
    """Every name the bundle's certificate is issued to (unverified: what to verify against)."""
    from cryptography import x509

    material = json.loads(bundle_json)["verificationMaterial"]
    raw = (material.get("certificate") or material["x509CertificateChain"]["certificates"][0])["rawBytes"]
    names = x509.load_der_x509_certificate(base64.b64decode(raw)).extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return [*names.get_values_for_type(x509.UniformResourceIdentifier), *names.get_values_for_type(x509.RFC822Name)]


def signed_version(bundle_json, signer=SIGNER, asked=None):
    """The version of the one release workflow run the certificate names, or None."""
    found = [name[len(signer):] for name in signers(bundle_json) if name.startswith(signer) and VERSION.fullmatch(name[len(signer):])]
    if len(found) != 1 or (asked is not None and found[0] != asked):
        return None
    return found[0]


def verify(archive, bundle_json, identity, issuer=ISSUER, offline=None):
    """Raise unless the bundle is a valid signature of `archive` by `identity`. `offline`: None
    tries Sigstore's update server first."""
    from sigstore.hashes import Hashed
    from sigstore.models import Bundle
    from sigstore.verify import Verifier, policy
    from sigstore_models.common.v1 import HashAlgorithm

    if offline is None:
        try:
            verifier = Verifier.production(offline=False)
        except Exception as error:  # unreachable, or refused: the trust root sigstore-python carries
            print(f"Sigstore's update server did not answer ({type(error).__name__}); using the trust root this verifier carries.", file=sys.stderr)
            verifier = Verifier.production(offline=True)
    else:
        verifier = Verifier.production(offline=offline)
    digest = hashlib.sha256()
    with open(archive, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    hashed = Hashed(algorithm=HashAlgorithm.SHA2_256, digest=digest.digest())
    verifier.verify_artifact(hashed, Bundle.from_json(bundle_json), policy.Identity(identity=identity, issuer=issuer))


def main(argv):
    if len(argv) not in (2, 3) or (len(argv) == 3 and not VERSION.fullmatch(argv[2])):
        print("usage: verify_release.py ARCHIVE BUNDLE [VERSION]", file=sys.stderr)
        return 2
    archive, bundle, asked = argv[0], argv[1], (argv[2] if len(argv) == 3 else None)
    # What the installer says is enough: not sigstore-python's notes on how it got its trust root.
    logging.getLogger("sigstore").setLevel(logging.ERROR)
    # Sigstore's trust cache in a place of its own, not the person's home.
    cache = tempfile.mkdtemp(prefix="anagram-sigstore-")
    os.environ.update(XDG_CACHE_HOME=os.path.join(cache, "cache"), XDG_DATA_HOME=os.path.join(cache, "data"))
    with open(bundle, "rb") as stream:
        bundle_json = stream.read()
    try:
        version = signed_version(bundle_json, asked=asked)
    except (ValueError, KeyError, TypeError) as error:
        print(f"The release's signature is not a Sigstore bundle ({error}).", file=sys.stderr)
        return 1
    if version is None:
        wanted = f"{SIGNER}{asked}" if asked else f"{SIGNER}<version>"
        print(f"The release's signature is not from Anagram's release workflow ({wanted}).", file=sys.stderr)
        return 1
    try:
        verify(archive, bundle_json, SIGNER + version)
    except Exception as error:
        print(f"The release's signature does not verify: {error}", file=sys.stderr)
        return 1
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
