# ShalaSign for Salesforce

A managed package that lets Salesforce users send ShalaSign templates from
Account, Contact, Opportunity (or any object via Flow), track the envelope on
the record, and get the signed PDF attached automatically when everyone has
signed. It talks to the same ShalaSign backend as the web app, so a document
sent from Salesforce also shows up in ShalaSign, and vice versa.

```
salesforce/
  scratch-def.json          scratch org definition used for development
  shalasign-salesforce/     SFDX project (deploy this folder)
    force-app/main/default/
      objects/ShalaSign_Envelope__c        one record per sent document
      objects/ShalaSign_Settings__c        protected custom setting: API key
      objects/ShalaSign_Template_Mapping__mdt   template ↔ object field mapping
      namedCredentials/ShalaSign           base URL of your ShalaSign server
      classes/                             Apex (client, service, controllers, Flow action, scheduler, tests)
      lwc/shalasignSetup                   Setup tab: paste API key, schedule sync
      lwc/shalasignSend                    "Send with ShalaSign" quick action
      lwc/shalasignEnvelopes               envelopes card for record pages
      quickActions/                        Account / Contact / Opportunity actions
      permissionsets/                      ShalaSign User, ShalaSign Admin
```

## How it works

| Piece | What it does |
| --- | --- |
| Setup tab | Admin pastes a ShalaSign API key (created in ShalaSign → Settings → API & webhooks). The key is verified against `/api/auth/me` before it is saved in a **protected** custom setting, so no subscriber code can read it. |
| Send with ShalaSign | Quick action on a record. Lists the sender's ShalaSign templates, pre-fills signers from the record (contact, account contacts, opportunity contact roles, case contact, lead), pre-fills `{{merge}}` fields from the template mapping, sends, and creates a `ShalaSign_Envelope__c` linked to the record. |
| ShalaSign Envelopes | Record-page component listing envelopes for that record with status, remind, void, open-in-ShalaSign, open signed PDF and refresh. |
| Status sync | Scheduled job (every 15 min, four cron entries) refreshes envelopes awaiting signature; when one completes it downloads the sealed PDF and attaches it as a File to the envelope and to the record. No inbound endpoint is needed, so it works for any org without exposing a public URL. |
| Flow action | `Send ShalaSign template` invocable for Flow Builder / automation: template id, record id, one or two signers, optional title, message and merge JSON. Returns envelope record id, ShalaSign id and error. |
| External reference | Every envelope created from Salesforce carries `external_system = salesforce`, `external_id = <record Id>`, `external_url = <record link>` in ShalaSign, visible in the web app and filterable via `GET /api/envelopes?external_system=salesforce&external_id=…`. |

Apex forbids callouts after DML in one transaction, so the service does all
HTTP work first (`prepare` / `fetch`) and all database work last (`commit`).
The Flow action therefore handles bulk requests correctly.

## Develop and test

```bash
cd salesforce/shalasign-salesforce
sf org create scratch --definition-file ../scratch-def.json --alias shalasign-dev --duration-days 14 --target-dev-hub <your-dev-hub>
sf project deploy start --source-dir force-app --target-org shalasign-dev --test-level RunLocalTests
sf org assign permset --name ShalaSign_Admin --target-org shalasign-dev
sf org open --target-org shalasign-dev --path /lightning/n/ShalaSign_Setup
```

Tests use an HTTP mock (`ShalaSignMock`) and run as a System Administrator
with the `ShalaSign_Admin` permission set, like a real installer. Last run:
12 tests, 0 failures, 98 % coverage.

### Point it at your ShalaSign

The Named Credential `ShalaSign` defaults to `https://signflow-up8f.onrender.com`.
In a subscriber org go to **Setup → Named Credentials → ShalaSign** and change
the URL if you self-host. The scratch org cannot reach `localhost`; for an
end-to-end test against a dev server, expose it with a tunnel and edit the
Named Credential.

### After install, an admin does

1. Assign **ShalaSign Admin** to themselves and **ShalaSign User** to senders.
2. Open the **ShalaSign Setup** tab, paste an API key, click **Connect**, then **Schedule sync job**.
3. Add the **Send with ShalaSign** action to the Account / Contact / Opportunity page layouts
   (Lightning App Builder → Highlights panel actions, or the page layout's Mobile & Lightning Actions).
4. Add the **ShalaSign Envelopes** component to those record pages.
5. Optional: create **Custom Metadata → ShalaSign Template Mapping** records to map merge keys to fields,
   for example `{"Company":"Account.Name","Amount":"Amount"}` on Opportunity, and a title template like `{{Name}} - Agreement`.

## Publish on AppExchange

The code is ready to be packaged; the following steps are account and business
tasks that need the Softshala Partner account.

1. **Join the Salesforce Partner Program** (partners.salesforce.com) as an ISV; this gives you the Partner Business Org (PBO) and the Partner Community listing tools.
2. **Register a namespace**: create a Developer Edition org, Setup → Package Manager → register namespace (e.g. `shalasign`), then link it to your Dev Hub (Setup → Namespace Registries in the Dev Hub). Set `"namespace": "shalasign"` in `sfdx-project.json`.
3. **Create the second-generation managed package**:
   ```bash
   sf package create --name "ShalaSign" --package-type Managed --path force-app --target-dev-hub <dev-hub>
   sf package version create --package "ShalaSign" --installation-key-bypass --code-coverage --wait 30 --target-dev-hub <dev-hub>
   sf package install --package 04t... --target-org <test-org> --wait 10
   sf package version promote --package 04t... --target-dev-hub <dev-hub>
   ```
4. **Security review**: run Salesforce Code Analyzer (`sf code-analyzer run --workspace force-app`) and fix findings; submit the package through the Partner Console (AppExchange → Technology → Security Review). The package already uses `with sharing`, `WITH USER_MODE` queries, a protected custom setting for the secret, and a Named Credential for the endpoint, which are the usual review requirements for a connected app.
5. **Listing**: in the Partner Console create the AppExchange listing (name, logo, screenshots, pricing, support URL), connect the package version, and publish. Listing content can reuse `docs/COMPARISON.md` and the main README.
6. **Both products stay integrated**: the independent ShalaSign web app and the Salesforce package share accounts, templates, envelopes and audit trail through the API key; a customer may use either or both.
