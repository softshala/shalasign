/**
 * Thin HTTP client for the ShalaSign REST API. The base URL comes from the
 * "ShalaSign" Named Credential (editable by admins); the API key from the
 * protected ShalaSign_Settings__c custom setting.
 */
public with sharing class ShalaSignClient {
    public class ShalaSignException extends Exception {}
    public static String overrideKey;

    /** Wrap any exception so the message reaches Lightning components (AuraHandledException hides it otherwise). */
    public static AuraHandledException aura(Exception e) {
        AuraHandledException ex = new AuraHandledException(e.getMessage()); ex.setMessage(e.getMessage()); return ex;
    }

    public static String apiKey() {
        if (overrideKey != null) return overrideKey;
        ShalaSign_Settings__c s = ShalaSign_Settings__c.getOrgDefaults();
        if (s == null || String.isBlank(s.API_Key__c)) {
            throw new ShalaSignException('ShalaSign is not connected yet. Open the ShalaSign Setup tab and enter an API key.');
        }
        return s.API_Key__c;
    }

    public static HttpResponse call(String method, String path, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ShalaSign' + path);
        req.setMethod(method);
        req.setTimeout(60000);
        req.setHeader('Authorization', 'Bearer ' + apiKey());
        req.setHeader('Accept', 'application/json');
        if (body != null) { req.setHeader('Content-Type', 'application/json'); req.setBody(body); }
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() == 401) throw new ShalaSignException('ShalaSign rejected the API key. Check it in ShalaSign Setup.');
        return res;
    }

    public static Map<String, Object> json(String method, String path, Object body) {
        HttpResponse res = call(method, path, body == null ? null : JSON.serialize(body));
        Object parsed;
        try { parsed = JSON.deserializeUntyped(res.getBody()); } catch (Exception e) { parsed = null; }
        if (res.getStatusCode() >= 400) {
            String msg = 'ShalaSign error ' + res.getStatusCode();
            if (parsed instanceof Map<String, Object> && ((Map<String, Object>) parsed).get('error') != null) msg = String.valueOf(((Map<String, Object>) parsed).get('error'));
            throw new ShalaSignException(msg);
        }
        if (parsed instanceof Map<String, Object>) return (Map<String, Object>) parsed;
        Map<String, Object> wrap = new Map<String, Object>(); wrap.put('items', parsed); return wrap;
    }

    public static Map<String, Object> me() { return json('GET', '/api/auth/me', null); }
    public static List<Object> listTemplates() { return (List<Object>) json('GET', '/api/templates', null).get('items'); }
    public static Map<String, Object> getTemplate(String id) { return json('GET', '/api/templates/' + EncodingUtil.urlEncode(id, 'UTF-8'), null); }
    public static Map<String, Object> useTemplate(String id, Map<String, Object> body) { return json('POST', '/api/templates/' + EncodingUtil.urlEncode(id, 'UTF-8') + '/use', body); }
    public static Map<String, Object> send(String envelopeId, Map<String, Object> body) { return json('POST', '/api/envelopes/' + envelopeId + '/send', body); }
    public static Map<String, Object> getEnvelope(String id) { return json('GET', '/api/envelopes/' + id, null); }
    public static Map<String, Object> remind(String id) { return json('POST', '/api/envelopes/' + id + '/remind', new Map<String, Object>()); }
    public static Map<String, Object> voidEnvelope(String id, String reason) { Map<String, Object> b = new Map<String, Object>(); b.put('reason', reason); return json('POST', '/api/envelopes/' + id + '/void', b); }
    public static Blob downloadSigned(String id) {
        HttpResponse res = call('GET', '/api/envelopes/' + id + '/download', null);
        if (res.getStatusCode() >= 400) throw new ShalaSignException('Could not download the signed PDF (' + res.getStatusCode() + ')');
        return res.getBodyAsBlob();
    }
}
