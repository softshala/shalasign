# SignFlow vs Adobe Acrobat Sign vs Zoho Sign

Feature-by-feature comparison of SignFlow against the two most widely used
commercial e-signature products, with the roadmap items that remain. Compiled
October 2026 from the vendors' own feature pages ([Adobe](https://www.adobe.com/sign/features.html),
[Zoho](https://www.zoho.com/sign/features.html)) and third-party reviews.

**Legend:** ✅ included · 🟡 partial / different approach · ❌ not available · 💰 paid tier / add-on at the vendor

## Sending & preparing

| Capability | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| Upload PDF, place fields by click, drag to move, resize | ✅ | ✅ | ✅ |
| Field types: signature, initials, date, text, checkbox | ✅ | ✅ + radio, dropdown, attachment, payment | ✅ + radio, dropdown, attachment |
| Required / optional text fields, labels, pre-filled values | ✅ | ✅ | ✅ |
| Multiple signers with signing order (sequential or parallel) | ✅ up to 10 | ✅ | ✅ |
| Private message per signer | ✅ | ✅ | ✅ |
| CC recipients receive the completed copy | ✅ | ✅ | ✅ |
| Drafts autosave while preparing | ✅ | ✅ | ✅ |
| Reusable templates (document + roles + fields + options) | ✅ | ✅ | ✅ (unlimited on mid tier) |
| Bulk send (one document, many individual recipients) | ✅ up to 500, CSV import | ✅ "Mega Sign" 💰 | ✅ 💰 Enterprise tier |
| Folders | ✅ | ✅ | ✅ |
| Multiple documents in one envelope | ❌ roadmap | ✅ | ✅ |
| Import from cloud storage (Drive/OneDrive/Dropbox) | ❌ upload only | ✅ | ✅ |
| Non-PDF input (DOCX, images) | ❌ PDF only | ✅ | ✅ |
| Text tags / auto field placement (`{{sig:1}}`, `{{Company}}`) | ✅ | ✅ | ✅ |
| Merge fields from Excel/CSV per recipient, validated before send | ✅ | ✅ Mega Sign CSV | ✅ via Zoho Sheet/CRM |
| Web forms / self-serve signing links (SignForms, Web Forms) | ❌ roadmap | ✅ | ✅ 💰 |
| In-person signing mode | 🟡 send to yourself + sign on the device | ✅ | ✅ 💰 |

## Signing experience

| Capability | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| No account needed for signers | ✅ | ✅ | ✅ |
| Works on phones (responsive, touch) | ✅ | ✅ + native apps | ✅ + native apps |
| Draw / type / upload signature (crop, rotate, background removal) | ✅ | ✅ | ✅ |
| Signer can move/resize their signature inside the box | ✅ | ✅ | ✅ |
| Remember signature for reuse | ✅ on the signer's device | ✅ account-based | ✅ account-based |
| Progress indicator, "next step" guidance | ✅ | ✅ | ✅ |
| Decline to sign with reason | ✅ | ✅ | ✅ |
| Access code (PIN) to open document | ✅ | ✅ | ✅ |
| Email OTP for signers | ❌ roadmap | ✅ | ✅ |
| SMS / phone / knowledge-based / ID-document verification | ❌ | ✅ 💰 | ✅ 💰 (SMS credits) |
| Required attachments from signers (ID documents) | ✅ per signer, appended to sealed PDF | ✅ attachment field | ✅ attachment field |
| Signer downloads their copy after completion | ✅ | ✅ | ✅ |
| Signing in other languages | ❌ English UI | ✅ 30+ | ✅ "vernacular signing" |
| Branded signing page & emails (logo, colour, company) | ✅ | ✅ | ✅ |

## Tracking, reminders & lifecycle

| Capability | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| Real-time status (sent, viewed, signed, waiting on) | ✅ | ✅ | ✅ |
| Automatic reminders every N days | ✅ | ✅ | ✅ |
| Manual "remind now" | ✅ | ✅ | ✅ |
| Signing deadline / expiry with notification | ✅ | ✅ | ✅ |
| Resend link, change a signer's email | ✅ | ✅ | ✅ |
| Void / recall | ✅ | ✅ | ✅ |
| Notify sender when a document is viewed | ✅ optional | ✅ | ✅ |
| Dashboard stats (awaiting, completed, average time to sign) | ✅ | ✅ reports | ✅ reports |
| Search by title, signer name or email | ✅ | ✅ | ✅ |
| Comments on a document between parties | ❌ | 🟡 | ✅ |

## Evidence, security & compliance

| Capability | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| Certificate of Completion appended to the PDF | ✅ | ✅ | ✅ |
| Full audit trail (IP, device, timestamps, every event) | ✅ sender copy; signer copy omits log | ✅ | ✅ |
| SHA-256 fingerprint of original and final document | ✅ | ✅ | ✅ |
| Encryption at rest (AES-256) | ✅ every PDF, signature and ID upload | ✅ | ✅ |
| Cryptographic PAdES / digital certificate seal (Adobe "green tick") | ❌ roadmap | ✅ | ✅ |
| Aadhaar eSign / eIDAS qualified signatures | ❌ | ✅ 💰 (eIDAS QES) | ✅ 💰 (Aadhaar eSign) |
| Blockchain timestamping | ❌ | ❌ | ✅ 💰 |
| Login: password, Google, Microsoft, emailed one-time code | ✅ | ✅ SSO 💰 | ✅ SSO |
| Password reset, login throttling | ✅ | ✅ | ✅ |
| Restrict account creation to company domains | ✅ | ✅ | ✅ |
| Data residency / self-hosting | ✅ your server, your disk | ❌ Adobe cloud | ❌ Zoho cloud (region choice) |
| Completed documents cannot be deleted (evidence retention) | ✅ | ✅ configurable | ✅ configurable |

## Integrations & automation

| Capability | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| REST API with API keys | ✅ same endpoints the app uses | ✅ 💰 | ✅ 💰 |
| Webhooks (sent, completed, declined, voided, expired), HMAC-signed, retried | ✅ | ✅ | ✅ |
| Send from the user's own inbox (Outlook / Gmail) | ✅ one-click connect | 🟡 platform sender, custom From needs setup | 🟡 platform sender |
| Automatic archive to OneDrive | ✅ user picks folder; or shared workspace folder | 🟡 via integrations | ✅ "cloud backup" |
| Archive to Google Drive | ✅ user picks folder | ✅ | ✅ |
| Archive to Dropbox / Box | ❌ | ✅ | ✅ |
| Team workspaces, roles, invitations | ✅ owner/admin/member | ✅ | ✅ |
| Admin choice: shared inbox / shared drive for the team | ✅ | 🟡 | 🟡 |
| CRM / HR integrations (Salesforce, Zoho CRM, Workday…) | ❌ build on API/webhooks | ✅ | ✅ Zoho suite |
| Microsoft 365 add-ins | ❌ | ✅ | ✅ |
| Zapier / Power Automate connectors | 🟡 via webhook + API | ✅ | ✅ |
| MCP server — use it from Claude (claude.ai, Desktop, Code) | ✅ built in, OAuth | ❌ | ❌ |
| AI assistant inside the app that performs actions | ✅ Claude with the same tools | 🟡 Acrobat AI Assistant (document Q&A) | 🟡 Zia (summaries) |
| AI field placement from document text | ✅ | ✅ (auto-detect form fields) | 🟡 |
| AI summary for signers ("What am I signing?") | ✅ | 🟡 AI Assistant for readers | 🟡 Zia summary |
| Natural-language send bar with attached PDF | ✅ | ❌ | ❌ |
| Payments collection during signing | ❌ | ✅ | ✅ 💰 |

## Pricing & deployment

| | SignFlow | Acrobat Sign | Zoho Sign |
|---|---|---|---|
| Cost | Hosting only (~US$7/month Render Starter, or a free Oracle VM) for unlimited users and envelopes | Per user per month; enterprise features on higher tiers | ~US$10–22 per user per month depending on tier (reviews differ) |
| Where data lives | Your disk, encrypted with your key; optional copy to your Microsoft 365 | Adobe cloud | Zoho cloud |
| Support | Your team / this repository | Vendor support | Vendor support |

## What the vendors do that SignFlow should add next

In rough order of value for a company-internal deployment:

1. **Email OTP for signers** — a second identity factor on top of the access code. Small change: the OTP module already exists for senders.
2. **Multiple documents per envelope** — merge uploaded PDFs into one envelope so a contract plus annexures go out together.
3. **Web forms** — a public signing link that anyone can open (NDA on a website, visitor forms).
4. **Cryptographic PAdES seal** with an organisation certificate so Adobe Reader shows a valid digital signature, and Aadhaar eSign for regulated Indian use cases.
5. **Radio / dropdown fields** and conditional fields.
6. **Localisation** of the signing page (Hindi and other Indian languages).
7. **DOCX and image upload** converted to PDF on the server.

## Where SignFlow is ahead

- **Ownership.** Documents, signatures and ID uploads stay on infrastructure you control, encrypted with a key only you hold, and are mirrored into your own Microsoft 365 tenant organised per sender.
- **Cost.** No per-user or per-envelope pricing; bulk send and templates are not gated behind an enterprise tier.
- **Transparency.** The full audit trail, hashing and sealing logic is readable code in this repository, which matters when evidence is challenged.
