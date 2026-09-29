# GovernWorld Chrome Extension — Privacy Policy

- **Version:** 2.0.0
- **Effective date:** September 24, 2026
- **Last updated:** September 24, 2026
- **Product:** GovernWorld Chrome Extension
- **Developer:** ACR LOGIC
- **Website:** governworld.acrlogic.com
- **Privacy contact:** privacy@acrlogic.com
- **Canonical URL:** `https://governworld.acrlogic.com/chrome-extension-privacy`
- **Support:** `https://github.com/ACR-LOGIC/governworld-extension/issues`

> **Legal notice:** This policy should be reviewed by qualified privacy counsel before being adopted as the company's legally operative policy. The final policy must accurately match the Extension's shipped permissions, APIs, telemetry, authentication, storage, network requests, update mechanism, and Chrome Web Store disclosures.

---

## 1. Introduction

ACR LOGIC ("ACR LOGIC," "GovernWorld," "we," "us," or "our") respects the privacy of individuals who use the GovernWorld Chrome Extension (the "Extension").

This Privacy Policy describes how the Extension handles information when you install or use it, including information processed locally on your device, information you voluntarily provide when using an optional GovernWorld account, information you voluntarily submit as a community contribution, and information associated with optional GovernWorld services.

GovernWorld is designed around a principle of **local processing whenever local processing is sufficient.**

## 2. Scope

This Privacy Policy applies specifically to the GovernWorld Chrome Extension and describes the Extension's handling of information.

Additional GovernWorld websites, applications, services, organizational deployments, subscriptions, APIs, and other products may be governed by separate privacy notices, terms, contracts, or data-processing agreements.

Where you use GovernWorld through an employer, healthcare organization, law firm, business, or other organization (an "Organization"), additional data practices may apply based on that Organization's configuration and contractual relationship with GovernWorld.

**If you are using GovernWorld through an Organization, please contact your Organization administrator for information about what information may be monitored, collected, retained, or governed under your organization's deployment.**

## 3. Privacy by Design

GovernWorld is designed to minimize unnecessary transmission of sensitive information. The Extension's local protection architecture is intended to operate according to the following principles:

- Process locally whenever practical.
- Do not transmit protected content merely because it is being inspected.
- Do not require an account for basic local redaction functionality.
- Do not require GovernWorld servers to receive the content being protected in order to perform local detection.
- Allow users to decide whether locally created detection logic remains private or is voluntarily contributed to the GovernWorld community.
- Separate detection logic from the underlying data used to create or test that logic.
- Use authenticated GovernWorld services only when a feature specifically requires them.

## 4. Use of the Extension Without an Account

You may use the Extension's basic local functionality without creating a GovernWorld account.

When used without an account, the Extension may perform supported detection and redaction operations locally on your device.

Basic local functionality does not require you to provide GovernWorld with your name, email address, documents, browser content, prompts, messages, PII, PHI, financial information, passwords, secrets, local test examples, or other sensitive content processed locally by the Extension.

Local processing does not, by itself, constitute transmission of that content to GovernWorld.

## 5. What the Extension Does

GovernWorld Redaction scans the visible text on the web pages you choose to scan, and the PDF/image/Word documents you choose to open, to find sensitive values such as phone numbers, email addresses, credit-card-like numbers, API keys and secrets, and other identifiers. It also checks accessibility attributes (`aria-label`, `alt`, `placeholder`, `title`) on pages you scan, in report-only form.

The Extension allows you to:

- Apply temporary in-page masks (an on-screen overlay that does not change the website).
- Optionally label masks with the category that was covered (e.g. `[SSN]`).
- Copy a redacted version of the visible text.
- Download a new, flattened copy of a document with the sensitive values covered in black.

Attribute findings are reported with masked previews only. The Extension never modifies any page attribute, and attribute values are never stored — the same no-raw-content rules described below apply to them.

## 6. Local Detection and Redaction

The Extension may inspect content accessible to it under the permissions granted to the Extension for the purpose of providing its disclosed detection, protection, and redaction functionality.

Where the relevant capability is implemented as local processing, the content is processed on your device.

The Extension may identify supported categories of sensitive information, including, depending on the version and enabled functionality, PII, PHI, financial information, payment-card information, authentication information, secrets and credentials, API keys and tokens, government-issued identifiers, addresses and contact information, and other supported sensitive-data patterns.

The specific detection capabilities may change as the Extension is updated.

**The Extension's local detection capability does not require GovernWorld to receive the underlying content merely because that content is inspected or redacted locally.**

## 7. Where Your Data Goes

**Local first, by default.** All detection, classification, and redaction runs on your device. The extension does not transmit your scanned page text, document contents, or page images anywhere unless you explicitly enable cloud analysis, and cloud analysis is disabled by default.

**Raw content handling.** The Extension does not persist raw scan text or page snapshots. When you open a document, its bytes are held in memory and in the Extension's private IndexedDB store only while you review or redact it. The bytes are deleted when you clear the document, complete a redaction, clear extension data, or start the browser. They are not deleted merely because the Extension's service worker restarts, which happens routinely: an MV3 service worker is suspended when idle and restarted on the next event, and clearing the document on every restart would destroy a file you were still reviewing. Raw document bytes are not sent to logs, telemetry, analytics, or error reporting.

The Extension also stores only the following non-content data:

- Settings and preferences you choose (e.g. which categories to detect).
- Temporary scan session state that is cleared when your browser closes.
- Local detection rules, rule metadata, and signed audit material needed for local operation.
- If you expressly choose to contribute a rule, the rule name, category, pattern, flags, capture setting, confidence, context cues, and length bounds may be sent to the GovernWorld community service for review. Original examples, documents, and page content are not included in that request.

**Cloud analysis (future, optional, off by default).** If and when cloud analysis ships, it will be an opt-in, per-operation feature. Before any cloud request you will be shown exactly what is being sent (text snippets or page images), the gateway organization, the purpose, and any retention. No cloud analysis feature exists in the current version, so no scan content leaves your device today.

**Optional account linking.** The side panel can link the Extension to an existing GovernWorld workspace by storing the approved gateway origin locally and holding the `gw_` API key only in browser session storage after you paste it. The key is used only to request billing metadata and open the Stripe checkout. It is never used to transmit scan content, document bytes, or masked values. No account is created by the Extension — linking reuses the tenant the key already belongs to. Clearing the account removes the origin and session credential.

**Optional community features.** When you explicitly choose to fetch community rules, the Extension requests eligible rule metadata from `community.governworld.acrlogic.com`. When you explicitly submit a contribution, it sends the rule name, category, pattern, flags, capture setting, confidence, optional context cues, and optional length bounds to that same service for review. These requests do not include source examples, page text, document bytes, page images, or account gateway credentials. A contribution is not active until accepted by the community review process.

## 8. Local Storage

Certain Extension functionality may require information to be stored locally on your device.

Depending on the functionality you use, locally stored information may include Extension configuration, user preferences, locally created detection rules, rule specifications, rule test results, local rule metadata, update preferences, local copies of approved detection logic, and other information necessary to operate the Extension locally. If you open a document, its bytes are temporarily staged in private browser storage for review and are removed by the cleanup paths described above.

Locally stored logic is not automatically transmitted to GovernWorld merely because it exists on your device.

Information stored locally may be lost if the Extension's local storage is cleared, the Extension is removed, browser data is deleted, or the device is replaced.

## 9. Logic Wizard

The Extension may provide a **Logic Wizard** that assists users in creating deterministic detection logic.

The Logic Wizard is designed to support a local workflow: **Category selection → Local examples/documents → Local analysis → Proposed logic → User review → Testing → User approval → Local logic.**

When the Logic Wizard operates locally, examples, documents, analysis, proposed logic, and testing remain on your device unless you expressly choose to share the resulting rule with GovernWorld.

Generating a proposed rule does **not** automatically make that rule active. The user must expressly approve a proposed rule before it is added to the user's local logic.

## 10. Local-Only Logic

You may choose to keep logic created with the Logic Wizard **Local Only.**

Local-only logic remains on the device where it was created, is not automatically saved to your GovernWorld account, is not automatically submitted to GovernWorld, is not automatically shared with the GovernWorld community, and will not automatically appear on another device merely because you subsequently sign into a GovernWorld account.

If you replace your device, clear the Extension's local storage, or otherwise lose locally stored information, GovernWorld may not be able to recover local-only logic because it was never transmitted to GovernWorld.

**Local-only means local-only.**

## 11. Voluntary Community Contributions

After creating and testing logic, you may be offered the option to **Share with the GovernWorld Community.** This is optional. You are not required to contribute logic in order to use the Extension or the Logic Wizard.

If you choose to contribute logic, GovernWorld may receive and store the **rule or logic specification and associated metadata necessary to evaluate, manage, review, or maintain the contribution.**

**Your contribution is the logic — not the source data.** The intended community contribution model does not require you to send GovernWorld the original documents, examples, prompts, messages, PHI, PII, or other sensitive material from which you developed the rule.

You should not submit sensitive source material as part of a community rule contribution unless the applicable GovernWorld interface expressly states otherwise and you have intentionally chosen to provide it.

## 12. Consent to Community Contribution

Before a rule is submitted to GovernWorld for community consideration, the Extension will provide an appropriate disclosure and request affirmative user action.

By choosing to submit a contribution, you acknowledge that:

- You are voluntarily sharing the applicable rule or logic with GovernWorld.
- GovernWorld may receive and store the submitted rule and associated metadata.
- GovernWorld may review, test, modify, reject, maintain, or otherwise process the submitted logic for community-rule purposes.
- Submission does not guarantee publication or acceptance.
- The underlying source examples and documents are intended to remain local unless separately submitted by you.
- A submitted contribution is no longer solely local to your device once transmitted to GovernWorld.

## 13. Community Review and Acceptance

Submitting a rule to GovernWorld does not automatically make it a community rule.

A contribution may undergo review, testing, validation, modification, or other quality and security controls before it is eligible for community distribution.

GovernWorld may accept, modify or normalize, reject, retain for account history where applicable, or remove/discontinue a previously published community rule.

## 14. Free GovernWorld Accounts

A GovernWorld account is optional for the Extension's basic local functionality.

If you voluntarily create a free GovernWorld account, GovernWorld may collect information necessary to establish and administer that account, including username, email address, authentication information or identifiers, account status, contribution history, voluntarily submitted rule specifications, and administrative metadata.

Creating an account does **not**, by itself, authorize GovernWorld to access your browser, documents, local files, prompts, messages, locally processed content, PHI, PII, Local-Only rules, or other information that the Extension processes locally.

## 15. Community Rule Updates

Users with a free GovernWorld account may have the option to opt in to community rule updates.

If you opt in, the Extension may receive eligible detection-rule updates that have been submitted by you or other community members and subsequently reviewed, tested, and approved for distribution by GovernWorld.

You may be offered a choice between **Automatic Updates** (eligible approved rule updates are received automatically) and **Manual Updates** (you initiate an update through the Extension's update function).

**Intended update flow:** GovernWorld publishes approved rule logic → GovernWorld pushes the eligible rule update → Your Extension receives the rule update → The rule is stored locally → Future local detection uses the updated logic.

The community update architecture is designed so that GovernWorld **pushes detection logic to the Extension rather than requiring the Extension to upload protected content to GovernWorld** for the purpose of determining which community rule should be applied.

Receiving a rule update does not, by itself, require GovernWorld to receive the webpage being protected, the document being inspected, the prompt being processed, the text being examined, PII, PHI, local test examples, or other protected content.

**The update contains detection logic, not the data that the logic protects.**

## 16. What the Extension Does Not Do

- It does not scan pages automatically in the background.
- It does not collect keystrokes, form values, cookies, session tokens, or private network traffic.
- It does not upload your browsing history.
- It does not transmit data for advertising, analytics, or model training.
- It does not use raw page or document content for telemetry or debugging.
- It does not claim that using it makes you or your organization compliant with HIPAA or any other regulation by itself.

## 17. Information GovernWorld Does Not Intend to Collect Through Local Protection

For local-only detection and redaction functionality, GovernWorld does not intend to collect or transmit the protected content merely because the Extension processes it.

This includes, where applicable, raw webpage text, documents, user prompts, chat messages, PHI, PII, financial information, passwords, secrets, local test examples, and other sensitive content processed solely for local detection.

This statement does not prohibit collection that is independently initiated by you, required for a separately enabled GovernWorld service, necessary for security or legal compliance, or expressly disclosed by the applicable feature.

## 18. Paid Services and Organizational Deployments

GovernWorld may offer paid services, organizational deployments, enterprise capabilities, APIs, runtime governance, policy enforcement, monitoring, audit, integrations, or other connected services.

These services may require transmission of information to GovernWorld or its service providers. The information processed depends on the specific product, configuration, permissions, organization policies, and services enabled.

An Organization may configure GovernWorld to provide governance or monitoring capabilities that necessarily involve information being transmitted to GovernWorld systems.

**The privacy characteristics of an organizational deployment are therefore not necessarily identical to those of the standalone free local Extension.**

If you use GovernWorld through an Organization, consult your Organization administrator regarding what information is monitored, collected, transmitted, retained, applicable organizational policies, retention periods, and available controls.

## 19. Data Sharing and Disclosure

ACR LOGIC does not sell Extension user data for advertising or behavioral advertising purposes.

Except as described in this Privacy Policy, GovernWorld does not intentionally disclose personal or sensitive user information to third parties for purposes unrelated to providing, securing, maintaining, or improving the disclosed functionality.

Information may be disclosed where reasonably necessary to: provide requested services; operate infrastructure and service providers acting on GovernWorld's behalf; maintain security and prevent abuse; comply with applicable law or legal process; protect rights, property, or safety; support a merger, acquisition, financing, reorganization, sale of assets, or similar corporate transaction; or where you have expressly authorized the disclosure.

## 20. No Advertising Use of Protected Content

GovernWorld does not use protected content processed by the Extension for targeted advertising.

GovernWorld does not intend to sell protected content, browsing content, PII, PHI, prompts, documents, or similar sensitive information to advertising networks, data brokers, or information resellers.

## 21. Human Access to User Data

GovernWorld's architecture is designed to minimize human access to sensitive user information.

GovernWorld personnel should not access protected user content unless such access is specifically authorized by the user, necessary for security or abuse investigation, required to comply with applicable law, or otherwise permitted under applicable privacy requirements and the disclosed purpose of the service.

Community rule contributions may be reviewed as part of the community contribution process because the contributor expressly submitted the rule to GovernWorld for review.

## 22. Security

ACR LOGIC uses reasonable administrative, technical, and organizational safeguards designed to protect information handled by GovernWorld.

Where personal or sensitive information is transmitted by the Extension or associated GovernWorld services, transmission is intended to use appropriate secure communications.

GovernWorld also designs the local Extension architecture to reduce unnecessary transmission of sensitive information by performing supported detection and redaction locally.

No method of electronic storage, transmission, or processing can be guaranteed to be completely secure. Accordingly, ACR LOGIC cannot guarantee absolute security of information.

## 23. Redacted Output

The flattened document you download is a new file. The original file is never modified. Redaction is baked into the pixels of the output so the covered values are not recoverable from that file by selecting, copying, searching, or un-hiding the covered areas.

## 24. Permissions

The Extension asks for the minimum permissions needed for its function:

- `activeTab` — scan only the page you are currently viewing, only after you press a button.
- `scripting` — inject the scanning/masking code into that page after your action.
- `storage` — remember your settings, local rules, and masked session state.
- `downloads` — save the flattened redacted document you create.
- `offscreen` — run document OCR and rendering in a dedicated offscreen document.
- `sidePanel` — show the side panel (`Alt+Shift+P`) for scanning, document redaction, notifications, and account/extension-license management.
- Approved GovernWorld host permissions — contact only the service origins needed for explicitly enabled linked features.
- `notifications` (optional, requested at runtime) — raise a notification when a scan finds sensitive data, only after you enable the toggle.

The extension does not request the `tabs`, `history`, `bookmarks`, `cookies`, or `webRequest` permissions, and it does not request arbitrary `*://*` host access. See `PERMISSIONS.md` for the full justification.

## 25. Data Retention

Retention depends on the type of information involved.

**Local information:** Information stored locally generally remains on your device until deleted by you, removed through Extension controls, removed when the Extension is uninstalled, removed through browser storage controls, or otherwise overwritten or deleted. Document bytes staged for review are removed by document clear, completed redaction, clear-data, browser startup, and Extension install or update. They are **not** removed by a service-worker restart, because an MV3 service worker is suspended when idle and restarted on the next event; purging on every restart would delete a document the user was still reviewing.

**Account information:** Information associated with a GovernWorld account may be retained as reasonably necessary to provide the account and services, maintain contribution history, satisfy legal obligations, resolve disputes, enforce agreements, and maintain security.

**Community contributions:** Rules voluntarily submitted to GovernWorld may be retained according to applicable account, community, operational, and legal requirements.

## 26. Local-Only Data and Device Changes

Information intentionally designated as **Local Only** is not intended to synchronize automatically to your GovernWorld account.

Consequently, local-only information may not be recoverable if you lose access to the device, replace the device, clear browser storage, remove the Extension, delete local data, or otherwise lose the local installation.

**If you do not voluntarily share local logic with GovernWorld, that logic does not follow your GovernWorld account to another device.**

## 27. Your Choices

Depending on the version of the Extension and services you use, you may be able to:

- Use the basic Extension without an account.
- Keep rules Local Only.
- Create and test logic locally.
- Decide whether to submit logic to GovernWorld.
- Opt in or out of community rule updates.
- Choose automatic or manual updates.
- Delete local Extension data.
- Manage your account.
- Request deletion of eligible account information.
- Stop using or uninstall the Extension.

Some information may need to be retained where required by law, necessary for security, required to complete a transaction, or otherwise permitted by applicable law.

## 28. Children's Privacy

The Extension is not directed to children under the age at which parental consent is required under applicable law. We do not knowingly seek to collect personal information from children in violation of applicable law.

If you believe that a child has provided personal information to GovernWorld in circumstances where such collection was not permitted, please contact us.

## 29. International Users

GovernWorld may operate infrastructure and use service providers located in jurisdictions other than your jurisdiction of residence. Where information is transferred across jurisdictions, ACR LOGIC will take measures required by applicable law.

## 30. Legal and Regulatory Compliance

This Privacy Policy describes GovernWorld's intended privacy practices and does not create or imply a contractual representation that any particular regulatory framework applies to every user, deployment, or use case.

Where applicable, GovernWorld may provide additional contractual protections, data-processing terms, business-associate agreements, or other compliance documentation for qualifying organizational customers.

Nothing in this Privacy Policy should be interpreted as a determination that the Extension or any particular deployment is subject to HIPAA, HITECH, GDPR, CCPA/CPRA, or another specific regulatory regime unless expressly stated in applicable contractual or legal documentation.

## 31. Changes to This Privacy Policy

ACR LOGIC may update this Privacy Policy to reflect changes to the Extension, GovernWorld services, data practices, applicable law, security or operational changes, or other legitimate business requirements.

When material changes are made, ACR LOGIC may provide notice through the Extension, GovernWorld website, account interface, Chrome Web Store listing, or other appropriate means.

The Last Updated date identifies when this Privacy Policy was most recently revised. Users should periodically review this Privacy Policy.

## 32. Chrome Web Store Limited Use Commitment

ACR LOGIC's use of information received through the GovernWorld Chrome Extension is intended to comply with the Chrome Web Store User Data Policy, including Limited Use requirements.

The Extension's collection, use, and transmission of user data are limited to purposes necessary to provide the Extension's disclosed functionality and related legitimate operational purposes, including maintaining security, preventing abuse, and maintaining reliability.

The Extension does not use or transfer user data for personalized advertising, retargeted advertising, or sale to data brokers.

The Extension does not require transmission of locally protected content to GovernWorld merely to perform local detection or redaction.

## 33. Important Disclaimer — No Automated Protection Can Guarantee Complete Detection

The GovernWorld Extension is a protective tool, not a guarantee that all PII, PHI, confidential information, or other sensitive information will be detected or successfully redacted.

Detection technology may contain limitations, including previously unknown data formats, unusual formatting, images, OCR errors, obfuscation, newly emerging identifiers, contextual information, false positives, false negatives, software defects, browser limitations, or other circumstances in which sensitive information may not be identified.

**You remain responsible for reviewing the results of any redaction or protection operation before transmitting, submitting, publishing, or otherwise disclosing information.**

Users should independently verify that:

- All intended PII and PHI have been successfully identified and redacted.
- No sensitive information remains.
- Redaction has not altered information in an unintended manner.
- Attachments, images, metadata, copied text, and associated content do not contain unprotected information.
- The resulting content is appropriate to disclose.

**Do not rely solely on the Extension to determine whether information is safe to disclose.**

## 34. Regulatory and Legal Responsibility

GovernWorld is not a substitute for your organization's privacy, security, compliance, legal, or regulatory controls.

If you are subject to HIPAA, HITECH, state privacy laws, contractual confidentiality obligations, professional obligations, or other legal or regulatory requirements, you remain responsible for determining what safeguards are required for your particular circumstances.

**ACR LOGIC does not warrant or guarantee that use of the Extension will satisfy HIPAA or any other legal, regulatory, contractual, or compliance requirement.**

To the maximum extent permitted by applicable law, ACR LOGIC and GovernWorld are not responsible for legal claims, regulatory actions, penalties, damages, losses, costs, or other consequences arising from a user's disclosure, transmission, publication, or exposure of PII, PHI, confidential information, or other protected information, including circumstances in which the Extension fails to detect or redact particular information.

This provision does not exclude or limit liability to the extent such exclusion or limitation is prohibited by applicable law.

## 35. Recommended Workflow

**Detect locally → Redact locally → Review the result → Verify that sensitive information is absent → Only then disclose or transmit.**

GovernWorld's objective is to provide the community with a useful additional layer of protection — not to replace responsible human review, organizational controls, or legally required safeguards.

**Protect locally. Verify before you disclose.**

## 36. Contact

**ACR LOGIC**
Privacy contact: privacy@acrlogic.com
Website: governworld.acrlogic.com
Privacy Policy: https://governworld.acrlogic.com/chrome-extension-privacy
Support: https://github.com/ACR-LOGIC/governworld-extension/issues