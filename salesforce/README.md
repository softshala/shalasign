# ShalaSign for Salesforce

The Salesforce AppExchange package moved to its own repository so it can be
opened as a standalone Salesforce DX project and deployed by manifest:

**https://github.com/softshala/shalasign-salesforce**

It talks to this server through the REST API with an API key, using the
`external_system` / `external_id` / `external_url` fields on envelopes to link
documents to Salesforce records. See that repository's README for install,
development and AppExchange publishing steps.
