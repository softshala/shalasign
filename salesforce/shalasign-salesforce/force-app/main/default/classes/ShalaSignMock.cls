@IsTest
public class ShalaSignMock implements HttpCalloutMock {
    public Integer calls = 0; public String lastPath; public String lastBody; public String sendBody; public String status = 'sent'; public Boolean failAuth = false;
    public HttpResponse respond(HttpRequest req) {
        calls++; lastPath = req.getEndpoint(); lastBody = req.getBody();
        HttpResponse res = new HttpResponse(); res.setHeader('Content-Type', 'application/json'); res.setStatusCode(200);
        String p = req.getEndpoint();
        if (failAuth) { res.setStatusCode(401); res.setBody('{"error":"Please log in"}'); return res; }
        if (p.endsWith('/api/auth/me')) res.setBody('{"id":"u1","name":"Shubham","email":"s@softshala.com"}');
        else if (p.endsWith('/api/templates')) res.setBody('[{"id":"tpl1","name":"Standard NDA","roles":[{"name":"Counterparty","attachments":[]}],"fields":[{"type":"signature","page":0,"x":0.1,"y":0.8,"w":0.2,"h":0.05,"signerIndex":0},{"type":"text","page":0,"x":0.1,"y":0.3,"w":0.3,"h":0.03,"signerIndex":0,"merge_key":"Company"}],"options":{"sequential":true,"expiry_days":7},"use_count":2}]');
        else if (p.contains('/api/templates/tpl1/use')) res.setBody('{"id":"env1","title":"Standard NDA"}');
        else if (p.contains('/api/templates/tpl1')) res.setBody('{"id":"tpl1","name":"Standard NDA","roles":[{"name":"Counterparty","attachments":[]}],"fields":[{"type":"signature","page":0,"x":0.1,"y":0.8,"w":0.2,"h":0.05,"signerIndex":0}],"options":{"sequential":true,"expiry_days":7}}');
        else if (p.contains('/send')) { sendBody = req.getBody(); res.setBody('{"status":"sent","emailed":true,"links":[]}'); }
        else if (p.contains('/download')) { res.setHeader('Content-Type', 'application/pdf'); res.setBodyAsBlob(Blob.valueOf('%PDF-1.4 fake')); }
        else if (p.contains('/remind')) res.setBody('{"ok":true,"reminded":["a@x.com"]}');
        else if (p.contains('/void')) { status = 'voided'; res.setBody('{"status":"voided"}'); }
        else if (p.contains('/api/envelopes/env1')) res.setBody('{"id":"env1","title":"Standard NDA","status":"' + status + '","sent_at":"2026-10-18 10:00:00","completed_at":' + (status == 'completed' ? '"2026-10-18 11:00:00"' : 'null') + ',"expires_at":"2026-10-25 10:00:00","seal_error":null,"signers":[{"name":"Asha","email":"a@x.com","status":"' + (status == 'completed' ? 'signed' : 'pending') + '"}]}');
        else { res.setStatusCode(404); res.setBody('{"error":"Not found"}'); }
        return res;
    }
}
