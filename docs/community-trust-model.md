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

## 10. Decisions

All four questions from the first draft are now answered. The project has one
maintainer, and that fact changes the key model rather than merely delaying it.

### 10.1 Key custody — decided: no signing key, ever

**There is no publisher signing key.** Two-person control cannot be satisfied by
one person, and pretending otherwise would mean claiming a control that does not
exist. The original draft assumed two custodians; that assumption is withdrawn.

The consequence is that the signed-pack design in sections 3 to 7 is **not the
design that will ship**. What ships instead is 10.1.1, which needs no key at all.
`src/shared/communityPack.ts` stays in the tree as reviewed, tested code for that
future, but `PINNED_COMMUNITY_PACK_PUBLIC_KEY` remains `null` and is not a
placeholder waiting to be filled in.

#### 10.1.1 The design that ships: rules as user-reviewed suggestions

Community rules are fetched over HTTPS and treated as **untrusted suggestions**.
Nothing is ever applied automatically. The user reads each rule and decides.

This removes the entire key-management problem, and with it the class of failure
that keys create: there is no key to steal, no custody policy to violate, no
rotation to run, and no revocation list to publish. What remains is the original
transport-authentication risk, and it is bounded by the fact that a hostile rule
is inert until a human accepts it.

The obligations that replace signing are therefore about *presentation*, not
cryptography:

- A community rule must be visibly attributed: who published it, when, and how
  many reports it has.
- Its pattern must be shown in full before acceptance, never truncated. A user
  who cannot read the rule cannot judge it.
- Its category and confidence must be displayed, because those decide where a
  finding lands.
- Acceptance is per rule and user-revocable, with no persistent global switch.
- `isValidCommunityRule()` still gates everything that reaches the UI. A rule
  that fails it is never presented as acceptable.
- The confidence clamp from section 7 still applies when an accepted rule runs.
- The in-app copy must continue to state that community rules are **not active in
  this release** until this path is actually built. That copy is asserted by
  `tests/claims-accuracy.test.ts`.

**If this is ever revisited**, it becomes a key problem again and the requirement
is non-negotiable: signing keys require a second holder. A solo maintainer
should not enable signing. They should use user-reviewed suggestions, which is
what this project does.

### 10.2 Revocation — decided: not applicable under 10.1.1

There is no signed pack to revoke, and the user *is* the revocation mechanism:
not accepting a rule, or removing an accepted one, takes effect immediately and
locally, with no server round trip and nothing to wait for.

That is a real advantage of the chosen design and worth stating plainly, because
section 8 documented a genuine weakness — revocation cannot bind an offline
client. Under 10.1.1 that weakness does not exist, because authority never leaves
the user's machine.

**If signed packs are ever adopted** despite the above: publish the revocation
list within **72 hours** of deciding to revoke, maintainer as sole on-call. The
4-hour target in the first draft was aspirational and is withdrawn as
unachievable by one person. 72 hours is a commitment a single maintainer can keep,
and the 7-day pack expiry remains the backstop behind it.

### 10.3 minClientVersion enforcement point — decided, implemented

Enforce **before anything is staged or installed**, in `verifyCommunityPack()`,
as step 4 of section 5. An old client must not learn about rules whose validation
it cannot perform, and a rejection must leave no stored state behind. Implemented
and covered by tests.

### 10.4 Rule-acceptance bar — decided, enforced in tooling

Thresholds are set here as hard numbers, and `scripts/rule-gate.mjs` enforces
them. A rule that fails any gate is not publishable.

| Gate | Threshold | Rationale |
|---|---|---|
| Precision on labelled examples | **≥ 98%** | Below this the rule corrupts documents often enough that users stop trusting output. Precision matters more than recall here: a missed value is one value on a document the user still reviews, while a false positive mangles their file and drives them to uninstall. |
| Benign-corpus false-positive rate | **< 1 in 20,000** | Measured across all benign documents, not just the ones matched. This is what catches the long tail of formats nobody anticipated. |
| `secrets` benign-corpus rate | **< 1 in 100,000** | Stricter, because a `secrets` false positive corrupts a user's own config files, which is the fastest route to the extension being removed. |
| Minimum distinct real examples | **≥ 25** | A rule matching fewer is tuned to one sample, not a detector. |
| ReDoS budget | **< 250 ms** on 200k hostile chars | `isSafeRegex()` is a syntactic gate, not a proof of bounded execution, so this is measured rather than assumed. |
| Lookbehind / backreference / nested quantifier | **prohibited** | Where correctness and ReDoS risk concentrate. No threshold; these are refused outright. |
| Minimum supported client version | **≥ 0.1.0** | Stops a pack from requiring a client older than the rules assume. |

**Human review** is required for anything in the `secrets` category, and for any
rule a user has reported as a false positive. With one maintainer that review is
self-review, and this document says so plainly rather than implying a second pair
of eyes. The compensating control is that publishing is a deliberate, recorded
act rather than something that happens on request. Rules are immutable once
published; a change is a new rule id.

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
