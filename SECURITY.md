# Security Policy — GovernWorld Chrome Extension

## Security Architecture & Guarantees

The GovernWorld Chrome Extension is designed with a **strict local-first, zero-telemetry security model**:

1. **On-Device Processing:** All detection, regular expression evaluation, identifier validation (SSN, Luhn, DEA, MBI, NPI), OCR extraction, and document flattening occur entirely on the user's local device.
2. **Zero Network Transmission:** The extension transmits zero scanned page content, zero raw sensitive findings, and zero document bytes over any network interface.
3. **No Automatic Host Access:** The extension requests zero `host_permissions`. It interacts only with the active tab upon explicit user gesture via `activeTab` and `scripting`.
4. **Transient Storage Lifecycle:** Document bytes are held in private local storage solely during active editing/redaction and are automatically purged upon download completion, user clearance, or service worker startup.
5. **Fail-Closed Tamper Evidence:** Audit logging records metadata-only, ECDSA-signed event chains verifying policy execution without exposing raw sensitive values.
6. **No Remote Code Execution:** The extension strictly enforces Manifest V3 Content Security Policy (`script-src 'self' 'wasm-unsafe-eval'`). No remote scripts, `eval()`, or dynamic code injection from untrusted sources are permitted.

## Reporting a Vulnerability

If you discover a security vulnerability or privacy violation within this project, please report it responsibly:

- **Email:** security@acrlogic.com
- **Response SLA:** We acknowledge all security reports within 24 hours and aim to release validated patches within 72 hours.
- Please do not disclose vulnerabilities publicly until a fix has been published.
