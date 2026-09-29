# Community rule trust model

**Status: design only. Not implemented.**

Both community network paths are currently stubbed off in the service worker and
return an error (`src/service-worker/index.ts`, cases `POPUP_COMMUNITY_CONTRIBUTE`
and `POPUP_COMMUNITY_FETCH_COMMUNITY_RULES`). Nothing is downloaded and nothing is
sent. This document exists so the paths are not switched on without the trust
decisions below being made deliberately.

## 1. What an attacker gains by controlling a rule pack

A community rule is not data — it is **detection policy**. Whoever supplies a
pack changes what every subsequent scan of every document reports. The concrete
harms, in rough order of severity:

1. **Silent under-detection.** A rule that never matches removes a category of
   protection without any visible symptom. The user sees a clean scan and
   discloses the document. This is the worst outcome and the easiest to hide.
2. **Over-redaction.** A pattern matching innocuous text masks the user's own
   content, so the "redacted" output is corrupted and unusable.
3. **Denial of service.** A catastrophic-backtracking pattern freezes scanning
   on every page afterwards. `isSafeRegex()` in
   `src/shared/customPatterns.ts` rejects known-bad shapes today, but it is a
   syntactic gate, not a proof of bounded execution.
4. **Category mislabelling.** Findings reported under the wrong category
   undermine any compliance claim made about the report.
5. **Targeted laundering.** A pattern tuned to one organisation's data, shipped
   as a generic community rule.

None of this is live today. Enabling the fetch path without trust means anyone
who can serve the response — a compromised origin, a hostile mirror, a
misconfigured CDN, a spoofed resolution — chooses the policy.

## 2. Why transport security is not enough

HTTPS protects the bytes in transit between two endpoints. It does not bind the
*content* to a publisher's decision, gives no offline verifiability, offers no
revocation, and provides nothing at all if the origin itself is compromised —
which is the case that matters, because the origin is the thing we are trying to
distinguish from an impostor.

A signature solves the different problem: it lets the extension verify a claim
about the bytes independently of who delivered them. Delivery becomes
untrusted; only the signature is trusted.

## 3. Key model

- Rules are signed with a **publisher signing key**: ECDSA P-256, SHA-256.
  This matches the primitive already used for audit records in
  `src/shared/audit.ts`, so there is one algorithm to reason about.
- The key is **non-extractable** and held offline or in an HSM. Whoever holds it
  can sign a hostile pack, so custody is the control, not the algorithm.
- The extension **pins the publisher public key at build time**, as a constant in
  source. Pinned in source means changing it is a visible diff that goes through
  code review and a store release, rather than a value fetched at runtime that
  an attacker could replace along with the pack.
- **One key, no hierarchy, at first.** A root/intermediate scheme is only needed
  to rotate without shipping a new extension. When rotation becomes necessary,
  pin two public keys (current and next) with a defined overlap window, so a
  pack signed by either verifies during the handover.

## 4. Pack format

The signature covers **the exact bytes received**, not a re-serialization of the
parsed object. Re-serializing introduces a canonicalisation problem — key
ordering, number formatting, Unicode normalisation — where the client and server
can disagree about what was signed while both believe they are verifying the
same document. Signing the raw response body removes that entire class of bug.
The server must therefore sign precisely what it serves.

```jsonc
{
  "packId":    "pack_2026_09",         // stable identity, used for revocation
  "issuedAt":  "2026-09-29T00:00:00Z",
  "expiresAt": "2026-10-06T00:00:00Z", // hard expiry, short
  "seq":       42,                     // monotonic, anti-rollback
  "minClientVersion": "0.2.0",         // pack may require newer validation
  "rules":     [ /* the rule objects */ ]
}
```

The signature travels either as a detached header or a sibling field, and covers
the response body byte-for-byte.

## 5. Verification order — every failure is fail-closed

Each step aborts on failure and leaves local rules untouched and fully working.

1. Fetch over HTTPS. Non-2xx, non-JSON, or oversized body → abort.
2. `expiresAt` in the past → abort. Reject implausible clock skew.
3. Verify the signature over the exact received bytes with a pinned public key.
   Failure → abort. This is the only step that establishes authenticity.
4. `minClientVersion` newer than the running version → abort. An old client
   must not install rules whose validation it cannot perform.
5. Every rule must pass `isValidCommunityRule()` — category, flag allowlist,
   length bounds, `isSafeRegex()`. **One invalid rule rejects the whole pack.**
6. Anti-rollback: reject any pack whose `seq` is not greater than the highest
   `seq` already accepted for that `packId`.
7. Install.

Steps 2 to 6 in §10's ordering, with one deliberate change from the first draft
of this document: rules are now **all-or-nothing** rather than individually
dropped. A pack is a coherent policy unit, and silently dropping one rule from a
validly signed pack leaves the user believing they have a protection they do not
have — which is the same failure mode as a pack that never matches, and is the
one thing this design exists to prevent. A validly signed pack containing a rule
that fails validation is a publisher bug, and failing loudly is the right
response to one.

On any abort the user is told community rules are unavailable. The extension must
**never** run unverified rules, and must never silently fall back to running them
anyway.

### What is implemented today

Step 1 of §9 is complete: `src/shared/communityPack.ts` implements the envelope
format, `parseCommunityPack()`, `verifyCommunityPack()`, the anti-rollback store
(`readAcceptedSeq` / `recordAcceptedPack`), and a pinned-key constant that is
**deliberately `null`**. 46 tests cover it, including real ECDSA P-256 signing
and tamper detection rather than a stubbed verifier.

The pinned key being null is the load-bearing property: it means no pack can
verify, so the network path cannot be enabled by accident. Wiring it up without
also provisioning and reviewing a key still leaves the path inert. Nothing
outside the test file imports the module, and both service-worker community
cases still return an error.

## 6. What a signature deliberately does not protect

Being explicit here prevents the design from being oversold:

- **A compromised publisher key signs a hostile pack.** Signature verification
  proves provenance, not quality. Mitigations are offline key custody, and
  publishing the key fingerprint where users and reviewers can see it so a
  change is noticeable.
- **A correctly signed bad rule is still a bad rule.** No cryptographic
  mechanism can distinguish a well-formed harmful pattern from a well-formed
  helpful one. This is why §7 constrains what a pack is even allowed to do.
- **Downgrade to an older valid pack.** Bounded by `seq` and short `expiresAt`.
- **Local tampering after installation.** Mitigate by storing the signature
  alongside the rules and re-verifying on load, or by accepting that local
  storage is inside the trust boundary — the same boundary the rest of the
  extension's local state already sits in.

## 7. Invariants that must hold even for a validly signed pack

Defence in depth, so that a key compromise is not catastrophic. A community
pack is strictly additive:

- A pack **may not disable, shadow, or replace a built-in category.** It can only
  add findings. There is no field by which a pack can turn a category off.
- `confidence` from a pack is **clamped below built-in rules** (proposed band:
  ≤ 0.90) so a pack can never outrank local detection, and never present as
  authoritative.
- Every pack rule is tagged `source: "community"` and is rendered distinctly in
  the UI, showing the `packId` and whether its signature verified.
- Existing per-rule bounds stay in force, as implemented in
  `src/shared/customPatterns.ts`: `ALLOWED_FLAGS = /^[gim]*$/` (the sticky `y`
  and `unicode` flags are excluded), community patterns capped at 500
  characters, the pack sliced to 500 rules, and `isSafeRegex()` on every
  pattern. Note these are bounds, not proofs: a regex can be syntactically
  acceptable and still pathological, which is why §10 asks what the review bar
  is for accepting a rule into a pack in the first place.

## 8. Revocation and its honest limit

Revocation is a revocation list signed by the same publisher key, consulted on
refresh; a revoked `packId` is refused. Short pack expiry bounds the window in
which a leaked pack remains useful.

The limit must be stated plainly rather than implied: the extension is
local-first and may be offline, so **revocation only takes effect when the
extension can reach the service**. An attacker who has already installed an
expired pack on a machine that never reconnects keeps its effect until the pack
expires by clock, and expiry is checked locally, not trusted to the server. This
is a real property of a local-first design, not something the signature scheme
fixes.

## 9. Rollout

Deliberately incremental; each step is independently shippable and testable.

1. Pack format and verifier, with the network path **still stubbed**. Unit tests
   only, including tampered-byte, wrong-key, expired, and replay cases.
2. Pin the publisher key in source. Path still stubbed.
3. Enable the **read** path only, with pack rules offered as **suggestions the
   user must explicitly accept**. Nothing changes in detection behaviour until
   accepted. Submission stays disabled.
4. Automatic updates, if ever — not recommended, and it should be a separate
   decision with its own review.

Step 3 is the recommended first enablement. Serving untrusted rules that
silently alter detection is a materially different risk from surfacing them for
the user to judge, and it keeps the user in the loop exactly where the
extension's threat model wants them.

## 10. Open questions

### 10.1 Key custody — specified, owner not yet named

The substance is decided; only a name is missing.

**Requirement.** The publisher signing key must be generated and held so that no
single person, and no single machine reachable from the internet, can sign a
pack unilaterally. Concretely:

- Generated on an offline or air-gapped host. Never on a build server, never in
  CI, never in a repository.
- Non-exportable wherever the platform allows it (HSM, or a
  `CryptoKey` with `extractable: false` in a hardened offline tool).
- Two-person control: release requires two distinct custodians. A single
  compromised laptop must not be sufficient to publish rules to every install.
- Access is logged with a timestamp, the pack id, and the operator identity, and
  the log is retained beyond pack expiry so a leak can be investigated.
- **The public key fingerprint is published** in the repository, the store
  listing, and the docs. A key change that nobody notices is a key compromise
  that goes undetected.
- Rotation is a store release, shipping two pinned keys (current and next) with
  an overlap window, then removing the old one in a later release.

**Still required from the business:** who the two custodians are, and which
hosting satisfies the offline/non-exportable requirement. Neither is a technical
decision.

### 10.2 Revocation runbook — procedure specified, owner not yet named

- A revocation list is signed by the **same** publisher key and served from the
  same endpoint as packs, containing revoked `packId`s with a timestamp and
  reason. Its signature is verified with the same pinned key.
- Consulted on every refresh, before installing anything.
- A revoked `packId` is refused, and its stored `seq` is cleared so a future
  pack for the same id can be accepted only at a higher sequence.
- **Target turnaround: publish the list within 4 hours of deciding to revoke.**
  A pack expiry of 7 days is the backstop, so a stale revocation list cannot
  extend a compromised pack's life by more than that.
- Trigger conditions, any of which starts the clock: suspected key compromise,
  discovery that a hostile rule was published, a validation bypass in the
  verifier, or a publisher-side signing accident.

**Still required from the business:** who is on call for that 4-hour target, and
who can authorise revocation.

### 10.3 `minClientVersion` enforcement point — decided and implemented

**Decided: enforce before anything is staged or installed**, in
`verifyCommunityPack()`, as step 4 of §5. An old client must not learn about
rules it cannot fully validate, and "community rules unavailable, update
required" is a better failure than a partially understood policy set. A test
asserts that an unparseable version on *either* side fails closed rather than
being coerced.

This also means the check must run before `recordAcceptedPack()`, so a rejected
pack leaves no stored state behind. Implemented and covered.

### 10.4 Rule-acceptance bar — substance specified, threshold open

The bar for a rule being *accepted into* a pack, because signing proves
provenance and not quality (§6):

**Automated, and must pass before any pack is signed:**

- `isValidCommunityRule()` — the same gate the extension enforces, so a rule can
  never be published that the extension would reject.
- A ReDoS check against hostile input of 200k characters, with a hard budget. The
  extension's `isSafeRegex()` is a syntactic gate, not a proof of bounded
  execution, so a rule must clear an actual timing measurement.
- A differential check: the rule must not match on a corpus of benign text
  (documentation, invoices, code samples) at a rate above a stated threshold.
  This is what stops a pack from quietly widening over-redaction.
- A precision floor on a labelled corpus, and a review of any rule that fires on
  fewer than a minimum number of distinct real-world examples — a rule that only
  ever matched one sample is a target, not a detector.

**Human, and required for:**

- Any rule in a `secrets` category. Those match credentials, and a false
  positive there corrupts a user's configuration while a false negative exposes
  a credential.
- Any rule with a lookbehind, a backreference, or a nested quantifier, since
  those are where the ReDoS and correctness risks concentrate.
- Any change to a rule an existing pack already ships. Rules are immutable once
  published; a change is a new rule id, so history stays auditable.

**Still required from the business:** who signs off the human review, and the
numeric thresholds for the precision floor and the benign-corpus false-positive
rate. The mechanism is specified; the numbers are a judgement call about risk
tolerance.

## 11. Non-goals

- **Raw page text, document bytes, and unmasked values never leave the device.**
  Signature verification is orthogonal to this and does not relax it.
- The document pipeline gains **no network path.** OCR and PDF assets stay
  vendored, and OCR stays fail-closed on unbundled languages.
- This document does not change the stubbed-off state of either community path.

## 12. Contribution screener: known limits

`screenContributionPayload()` exists to enforce PRIVACY.md's "your contribution
is the logic, not the source data" promise. An independent review flagged
"separator and normalisation gaps" without listing them, so they were then
enumerated empirically. Nine were real and are now closed:

- Dot- and slash-separated identifiers (`219.09.9999`, `219/09/9999`).
- Non-breaking, thin, en, and em spaces and dashes as separators. `\s` already
  covers the Unicode spaces but not the en/em dashes that appear in text
  produced by word processors and pasted from typeset documents.
- Fullwidth digits and fullwidth card numbers, via NFKC folding.
- Email addresses with a non-ASCII local part, such as `josé@realco.com`.

One trap worth recording: the first version of the normaliser folded `.` and `/`
to hyphens as well, which silently broke the email check — `a.b@realco.com`
became `a-b@realco-com` and stopped matching at all. A normalisation that
destroys the structure the next check depends on is worse than no normalisation.
Dots and slashes are now handled in the identifier pattern instead, and tests
assert the ordinary forms still pass.

**Deliberately not folded: Arabic-Indic, Devanagari, and similar digits.** Every
identifier these checksums cover is defined over ASCII digits, so a string
written in another script is not a malformed instance of any of them — it is not
one of them, and there is no checksum for it to satisfy. Folding them would need
a per-script zero-offset table. `Number()` is not a shortcut either: it parses
only ASCII, so it returns `NaN` for U+0669, and the first attempt at this
rewrite replaced such digits with the literal string `"NaN"`.

The normaliser runs only on the screening copy. The submitted rule is the user's
own text, byte for byte, because normalising it would rewrite someone's pattern
into a different rule from the one they tested.
