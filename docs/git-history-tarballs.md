# Should the release tarballs be removed from git history?

**Short answer: technically easy, and my recommendation is to wait until after
the store submission is live.** The rewrite is prepared and measured on this
branch, so it becomes a two-minute job whenever you want it.

Investigated 2026-09-29 on `chore/history-slimming`.

## The situation

`release/*.tar.gz` is now gitignored and untracked going forward, but seven
tarballs were committed before that rule existed and remain in history:

| Commit | Archive | Size |
|---|---|---|
| `dfcf02a` | `governworld-redaction-dfcf02a.tar.gz` | 14.4 MB |
| `644e0f2` | `governworld-redaction-644e0f2.tar.gz` | 14.4 MB |
| `413b3a7` | `governworld-redaction-413b3a7.tar.gz` | 14.4 MB |
| `7756775` | `governworld-redaction-7756775.tar.gz` | 14.4 MB |
| `a62aed6` | `governworld-redaction-a62aed6.tar.gz` | 14.4 MB |
| `0eb545c` | `governworld-redaction-0eb545c.tar.gz` | 14.4 MB |
| `a3138eb` | `governworld-redaction-a3138eb.tar.gz` | 14.4 MB |

Seven distinct blobs, no deduplication available, **100.5 MB**.

## What it would actually cost, measured

A valid rewrite already exists on this branch: 44 commits, **zero tarball
blobs**, all source identical. `git filter-repo` completed in under a second.

Summing every reachable object, which is the only reliable measure — a local
`git clone` silently reuses the source pack, including unreachable objects, so
`du` on a clone understates the saving and misled an earlier attempt:

| | Reachable content | Objects |
|---|---|---|
| `main` today | 120.7 MB | 700 |
| After the rewrite | 20.1 MB | 669 |
| **Reclaimable** | **100.6 MB (83%)** | 31 |

What remains is `vendor/tessdata/eng.traineddata.gz` at 10.4 MB — tracked, and
required by the build — plus `brand/logo-master.png` at 1.4 MB and the test
fixtures.

## Can we make a new tar and delete the old ones from history?

Yes. That is exactly what a rewrite does, and it is already done and verified on
this branch. But note the framing: it is not "a new tar" — the current artifact
`bd9ec12` is already built, digest-verified, and uploaded-ready. The rewrite
produces a *new set of commit SHAs* for the same code.

## The costs, and why I recommend waiting

**1. It breaks the submission's provenance, which is the thing that actually
matters right now.** 13 commit SHAs are recorded by name in the documentation —
11 in `RELEASE_EVIDENCE.md`, 2 in `STORE_READINESS.md`. After a rewrite every one
of them refers to a commit that no longer exists. That includes the artifact
name itself: `governworld-redaction-bd9ec12.zip` is named for `bd9ec12`, and
`scripts/verify-release-digests.mjs` resolves recorded SHAs through
`git cat-file`. Rewriting would mean renaming the artifact and rewriting the
evidence that certifies it. That is circular and fragile to get right, and it is
a poor thing to be doing days before a first listing.

**2. It rewrites published history on a public repository.** 44 commits on
`main` and 6 on `licensing/source-available`, all of which get new SHAs. Anyone
who has cloned must re-clone or hard-reset.

**3. It requires a force-push to a protected branch.** Branch protection has
already been overridden twice on `main`. A force-push that rewrites every commit
is the most invasive action available, and it is a governance decision, not a
housekeeping one.

**4. There is no pressure forcing it.** GitHub's soft warning begins around
1 GB. This repository's reported disk usage is 115 MB, so the tarballs are about
a tenth of the way to any threshold that would ever prompt GitHub. Clones are
already fast at this size.

## The risk this was meant to solve is already solved

The real concern with nineteen archives in `release/` was uploading the wrong
one to the store — several are marked *do not submit* in `RELEASE_EVIDENCE.md`,
and that is not a recoverable mistake for a first listing. That is addressed
forward, not by rewriting:

- `release/*.tar.gz` is gitignored, so the pile stops growing.
- `npm run clean` / `npm run clean:apply` removes superseded archives, and only
  ever removes one whose commit is still in the repository, so anything
  reproducible is safe to drop.
- `npm run verify:digests` re-checks every recorded digest in CI, so a
  substituted or stale artifact fails the build.

## Recommendation

Do not rewrite now. Submit first, confirm the listing is live and accepted, then
run the rewrite as a standalone maintenance task with nothing else in flight.

If you would rather do it now anyway, the runbook is below and this branch is
already the rewritten history, so step 1 is verified rather than theoretical.

## Runbook (only if you decide to proceed)

**Never run this from the project directory.** `git filter-repo` operates on the
repository in the *current working directory* and ignores a path you hand it.
During this investigation it rewrote the working repository by accident when run
from here; the damage was recoverable only because nothing had been pushed, and
`main` was restored from `origin` with a single fetch. Rehearse in an isolated
clone with the working directory moved elsewhere.

```bash
# 0. Safety: confirm the remote is the source of truth and is clean.
git status --porcelain            # must be empty
git ls-remote --heads origin      # record this; you will force-push over it

# 1. Rehearse in isolation. Do NOT use --mirror: it copies the source pack
#    wholesale, including unreachable objects, so the measurement is wrong.
cd /somewhere/else
git clone --bare --single-branch --no-hardlinks \
    --branch chore/history-slimming <repo> rehearsal.git
git -C rehearsal.git rev-list --objects --all | grep -c '\.tar\.gz$'
# expect 0

# 2. If the rehearsal is clean, remove the origin remote first. filter-repo
#    strips it as a safety measure, which leaves you unable to push until you
#    re-add it — better to do it deliberately.
git remote remove origin
git remote add origin https://github.com/ACR-LOGIC/governworld-extension.git

# 3. Rewrite every branch that reaches the blobs. Missing one keeps the objects
#    alive and achieves nothing.
git filter-repo --force --path-glob 'release/governworld-redaction-*.tar.gz' \
    --refs refs/heads/main refs/heads/licensing/source-available

# 4. Verify before pushing anything.
git rev-list --objects --all | grep -c '\.tar\.gz$'   # expect 0
npm ci && npm run typecheck && npm test               # expect 58 files / 1078 tests

# 5. Rewrite the evidence, then force-push. This renames the artifact.
#    RELEASE_EVIDENCE.md and STORE_READINESS.md hold 13 SHAs by name.
git push --force-with-lease origin main
git push --force-with-lease origin licensing/source-available

# 6. Re-release under the new SHA and update the digests.
npm run release:zip <new-sha>
npm run verify:zip release/governworld-redaction-<new-sha>.zip
npm run verify:digests
```

Expect branch protection to reject the force-push and require an admin override.
That is a deliberate decision, not an obstacle to route around.
