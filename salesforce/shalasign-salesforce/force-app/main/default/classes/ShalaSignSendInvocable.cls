/** Flow action: "Send ShalaSign template". */
public with sharing class ShalaSignSendInvocable {
    public class Request {
        @InvocableVariable(label='ShalaSign template Id' required=true) public String templateId;
        @InvocableVariable(label='Record Id' required=true) public Id recordId;
        @InvocableVariable(label='Signer name' required=true) public String signerName;
        @InvocableVariable(label='Signer email' required=true) public String signerEmail;
        @InvocableVariable(label='Second signer name') public String signer2Name;
        @InvocableVariable(label='Second signer email') public String signer2Email;
        @InvocableVariable(label='Document title') public String title;
        @InvocableVariable(label='Message to signers') public String message;
        @InvocableVariable(label='Merge values (JSON object)') public String mergeJson;
    }
    public class Result { @InvocableVariable public Id envelopeRecordId; @InvocableVariable public String shalasignId; @InvocableVariable public String error; }

    @InvocableMethod(label='Send ShalaSign template' description='Sends a ShalaSign template for signature and links the envelope to the record.' category='ShalaSign' callout=true)
    public static List<Result> send(List<Request> requests) {
        // Phase 1: HTTP for every request (no DML yet, Apex forbids callouts after DML).
        List<Result> out = new List<Result>();
        List<ShalaSignService.Prepared> prepared = new List<ShalaSignService.Prepared>();
        for (Request q : requests) {
            Result r = new Result(); out.add(r);
            try {
                ShalaSignService.SendRequest sr = new ShalaSignService.SendRequest();
                sr.templateId = q.templateId; sr.recordId = q.recordId; sr.title = q.title; sr.message = q.message; sr.signers = new List<ShalaSignService.Signer>();
                ShalaSignService.Signer s1 = new ShalaSignService.Signer(); s1.name = q.signerName; s1.email = q.signerEmail; sr.signers.add(s1);
                if (String.isNotBlank(q.signer2Email)) { ShalaSignService.Signer s2 = new ShalaSignService.Signer(); s2.name = q.signer2Name; s2.email = q.signer2Email; sr.signers.add(s2); }
                if (String.isNotBlank(q.mergeJson)) {
                    sr.mergeData = new Map<String, String>();
                    Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(q.mergeJson);
                    for (String k : raw.keySet()) sr.mergeData.put(k, String.valueOf(raw.get(k)));
                } else {
                    ShalaSignRecordContext.Context ctx = ShalaSignRecordContext.build(q.recordId, q.templateId);
                    sr.mergeData = ctx.mergeValues; if (String.isBlank(sr.title)) sr.title = ctx.suggestedTitle;
                }
                prepared.add(ShalaSignService.prepare(sr));
            } catch (Exception e) { r.error = e.getMessage(); prepared.add(null); }
        }
        // Phase 2: write the envelope records.
        for (Integer i = 0; i < out.size(); i++) {
            if (prepared[i] == null) continue;
            try { ShalaSign_Envelope__c env = ShalaSignService.commitPrepared(prepared[i]); out[i].envelopeRecordId = env.Id; out[i].shalasignId = env.ShalaSign_Id__c; }
            catch (Exception e) { out[i].error = e.getMessage(); }
        }
        return out;
    }
}
