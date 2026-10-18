/**
 * Business logic: send a ShalaSign template from a record, keep envelope
 * records in sync, attach the signed PDF to the record when complete.
 *
 * Apex forbids callouts after DML in one transaction, so every method does
 * its HTTP work first (prepare / fetch) and its database work last (commit).
 */
public with sharing class ShalaSignService {
    public class Signer { @AuraEnabled public String name; @AuraEnabled public String email; @AuraEnabled public String role; }
    public class SendRequest {
        @AuraEnabled public String templateId; @AuraEnabled public Id recordId; @AuraEnabled public String title; @AuraEnabled public String message;
        @AuraEnabled public List<Signer> signers; @AuraEnabled public Map<String, String> mergeData;
    }
    /** Result of the HTTP phase of a send: everything needed to write records without further callouts. */
    public class Prepared { public Map<String, Object> remote; public Id recordId; public String templateName; }
    /** Result of the HTTP phase of a sync. */
    public class Fetched { public ShalaSign_Envelope__c local; public Map<String, Object> remote; public Blob signedPdf; public String error; }

    /** Send a template for the given record (callouts + DML). Returns the upserted envelope record. */
    public static ShalaSign_Envelope__c sendFromTemplate(SendRequest r) { return commitPrepared(prepare(r)); }

    /** HTTP phase: validate against the template, create the envelope from it, send it, read it back. No DML. */
    public static Prepared prepare(SendRequest r) {
        if (r.signers == null || r.signers.isEmpty()) throw new ShalaSignClient.ShalaSignException('At least one signer is required');
        Map<String, Object> tpl = ShalaSignClient.getTemplate(r.templateId);
        List<Object> roles = (List<Object>) tpl.get('roles');
        if (roles != null && roles.size() != r.signers.size()) throw new ShalaSignClient.ShalaSignException('Template "' + tpl.get('name') + '" needs ' + roles.size() + ' signer(s)');
        String recordUrl = URL.getOrgDomainUrl().toExternalForm() + '/' + r.recordId;
        String title = String.isBlank(r.title) ? String.valueOf(tpl.get('name')) : r.title;
        Map<String, Object> useBody = new Map<String, Object>{ 'title' => title, 'external_system' => 'salesforce', 'external_id' => String.valueOf(r.recordId), 'external_url' => recordUrl };
        Map<String, Object> draft = ShalaSignClient.useTemplate(r.templateId, useBody);
        String envId = String.valueOf(draft.get('id'));
        List<Object> signerPayload = new List<Object>();
        for (Integer i = 0; i < r.signers.size(); i++) {
            Signer s = r.signers[i];
            Map<String, Object> sp = new Map<String, Object>{ 'name' => s.name, 'email' => s.email };
            if (roles != null && i < roles.size() && (roles[i] instanceof Map<String, Object>)) sp.put('attachments', ((Map<String, Object>) roles[i]).get('attachments'));
            signerPayload.add(sp);
        }
        Map<String, Object> opts = (tpl.get('options') instanceof Map<String, Object>) ? (Map<String, Object>) tpl.get('options') : new Map<String, Object>();
        Map<String, Object> sendBody = new Map<String, Object>{
            'signers' => signerPayload, 'fields' => tpl.get('fields'), 'sequential' => opts.get('sequential') != false,
            'title' => title, 'message' => String.isBlank(r.message) ? String.valueOf(opts.get('message') == null ? '' : opts.get('message')) : r.message,
            'merge' => r.mergeData == null ? new Map<String, String>() : r.mergeData, 'expiry_days' => opts.get('expiry_days'), 'reminder_days' => opts.get('reminder_days'),
            'external_system' => 'salesforce', 'external_id' => String.valueOf(r.recordId), 'external_url' => recordUrl
        };
        ShalaSignClient.send(envId, sendBody);
        Prepared p = new Prepared();
        p.remote = ShalaSignClient.getEnvelope(envId); p.recordId = r.recordId; p.templateName = String.valueOf(tpl.get('name'));
        return p;
    }

    /** DML phase of a send. */
    public static ShalaSign_Envelope__c commitPrepared(Prepared p) {
        ShalaSign_Envelope__c env = upsertFromRemote(p.remote, p.recordId, null);
        env.Template_Name__c = p.templateName;
        update env;
        return env;
    }

    /** HTTP phase of a sync: read the envelope and, when it just completed, download the signed PDF. No DML. */
    public static Fetched fetch(ShalaSign_Envelope__c local) {
        Fetched f = new Fetched(); f.local = local;
        try {
            f.remote = ShalaSignClient.getEnvelope(local.ShalaSign_Id__c);
            if (String.valueOf(f.remote.get('status')) == 'completed' && String.isBlank(local.Signed_File_Id__c)) {
                try { f.signedPdf = ShalaSignClient.downloadSigned(local.ShalaSign_Id__c); } catch (Exception e) { f.error = 'PDF download failed: ' + e.getMessage(); }
            }
        } catch (Exception e) { f.error = e.getMessage(); }
        return f;
    }

    /** DML phase of a sync. */
    public static ShalaSign_Envelope__c commitFetched(Fetched f) {
        if (f.remote == null) {
            f.local.Error__c = String.isBlank(f.error) ? null : f.error.left(255); f.local.Last_Synced__c = System.now(); update f.local; return f.local;
        }
        ShalaSign_Envelope__c env = upsertFromRemote(f.remote, String.isBlank(f.local.Record_Id__c) ? null : Id.valueOf(f.local.Record_Id__c), f.signedPdf);
        if (String.isNotBlank(f.error)) { env.Error__c = f.error.left(255); update env; }
        return env;
    }

    /** Create or update the local envelope record from ShalaSign's detail payload and attach the signed PDF if provided. */
    public static ShalaSign_Envelope__c upsertFromRemote(Map<String, Object> remote, Id recordId, Blob signedPdf) {
        String sfId = String.valueOf(remote.get('id'));
        List<ShalaSign_Envelope__c> existing = [SELECT Id, Name, ShalaSign_Id__c, Signed_File_Id__c, Record_Id__c FROM ShalaSign_Envelope__c WHERE ShalaSign_Id__c = :sfId LIMIT 1];
        ShalaSign_Envelope__c env = existing.isEmpty() ? new ShalaSign_Envelope__c(ShalaSign_Id__c = sfId) : existing[0];
        env.Name = String.valueOf(remote.get('title') == null ? 'Document' : remote.get('title')).left(80);
        env.Status__c = String.valueOf(remote.get('status'));
        env.Sent_At__c = parseDate(remote.get('sent_at'));
        env.Completed_At__c = parseDate(remote.get('completed_at'));
        env.Expires_At__c = parseDate(remote.get('expires_at'));
        env.Last_Synced__c = System.now();
        env.Error__c = remote.get('seal_error') == null ? null : String.valueOf(remote.get('seal_error')).left(255);
        if (recordId != null) { env.Record_Id__c = recordId; env.Related_Object__c = String.valueOf(recordId.getSObjectType()); linkLookup(env, recordId); }
        List<Object> signers = (List<Object>) remote.get('signers');
        if (signers != null) {
            env.Signers__c = JSON.serialize(signers);
            List<String> parts = new List<String>();
            for (Object o : signers) { Map<String, Object> s = (Map<String, Object>) o; parts.add(s.get('name') + ' (' + s.get('status') + ')'); }
            env.Signer_Summary__c = String.join(parts, ', ').left(255);
        }
        upsert env ShalaSign_Id__c;
        if (signedPdf != null && String.isBlank(env.Signed_File_Id__c)) attachSignedPdf(env, signedPdf);
        return env;
    }

    private static void linkLookup(ShalaSign_Envelope__c env, Id recordId) {
        String t = String.valueOf(recordId.getSObjectType());
        if (t == 'Account') env.Account__c = recordId; else if (t == 'Contact') env.Contact__c = recordId; else if (t == 'Opportunity') env.Opportunity__c = recordId;
    }

    /** Store the sealed PDF as a File on the envelope and share it with the related record. */
    public static void attachSignedPdf(ShalaSign_Envelope__c env, Blob pdf) {
        try {
            ContentVersion cv = new ContentVersion(Title = env.Name + ' (signed)', PathOnClient = env.Name.replaceAll('[^A-Za-z0-9 ._-]', '_') + '-signed.pdf', VersionData = pdf, FirstPublishLocationId = env.Id);
            insert cv;
            cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id];
            if (String.isNotBlank(env.Record_Id__c)) {
                try { insert new ContentDocumentLink(ContentDocumentId = cv.ContentDocumentId, LinkedEntityId = env.Record_Id__c, ShareType = 'V', Visibility = 'AllUsers'); } catch (Exception ignore) { System.debug(ignore); }
            }
            env.Signed_File_Id__c = cv.ContentDocumentId;
            update env;
        } catch (Exception e) { env.Error__c = ('PDF attach failed: ' + e.getMessage()).left(255); update env; }
    }

    /** Refresh one envelope from ShalaSign. */
    public static ShalaSign_Envelope__c sync(Id envelopeRecordId) {
        ShalaSign_Envelope__c env = [SELECT Id, ShalaSign_Id__c, Record_Id__c, Signed_File_Id__c FROM ShalaSign_Envelope__c WHERE Id = :envelopeRecordId];
        Fetched f = fetch(env);
        if (f.remote == null) throw new ShalaSignClient.ShalaSignException(f.error);
        return commitFetched(f);
    }

    /** Refresh every envelope still awaiting signature (scheduled job). All callouts first, then all DML. */
    public static Integer syncOpen(Integer maxCallouts) {
        List<Fetched> fetched = new List<Fetched>();
        for (ShalaSign_Envelope__c env : [SELECT Id, ShalaSign_Id__c, Record_Id__c, Signed_File_Id__c FROM ShalaSign_Envelope__c WHERE Status__c IN ('sent', 'draft') ORDER BY Last_Synced__c NULLS FIRST LIMIT :maxCallouts]) {
            if (Limits.getCallouts() >= Limits.getLimitCallouts() - 2) break;
            fetched.add(fetch(env));
        }
        Integer n = 0;
        for (Fetched f : fetched) { commitFetched(f); if (f.remote != null) n++; }
        return n;
    }

    @TestVisible private static Datetime parseDate(Object v) {
        if (v == null) return null;
        try { String s = String.valueOf(v).replace(' ', 'T'); if (!s.endsWith('Z')) s += 'Z'; return (Datetime) JSON.deserialize('"' + s + '"', Datetime.class); } catch (Exception e) { return null; }
    }
}
