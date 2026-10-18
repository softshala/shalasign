/** Works out candidate signers and merge values for a record, using the admin's template mapping. */
public with sharing class ShalaSignRecordContext {
    public class Candidate { @AuraEnabled public String name; @AuraEnabled public String email; @AuraEnabled public String label; }
    public class Context {
        @AuraEnabled public String objectName; @AuraEnabled public String recordName; @AuraEnabled public List<Candidate> contacts = new List<Candidate>();
        @AuraEnabled public Map<String, String> mergeValues = new Map<String, String>(); @AuraEnabled public String suggestedTitle; @AuraEnabled public String mappedTemplateId;
    }

    public static Context build(Id recordId, String templateId) {
        Context c = new Context();
        Schema.SObjectType t = recordId.getSObjectType();
        c.objectName = String.valueOf(t);
        ShalaSign_Template_Mapping__mdt mapping;
        for (ShalaSign_Template_Mapping__mdt m : [SELECT Template_Id__c, Object_API_Name__c, Merge_Map__c, Signer_Contact_Field__c, Title_Template__c FROM ShalaSign_Template_Mapping__mdt WHERE Object_API_Name__c = :c.objectName]) {
            if (templateId == null || m.Template_Id__c == templateId) { mapping = m; break; }
        }
        if (mapping != null) c.mappedTemplateId = mapping.Template_Id__c;
        Set<String> paths = new Set<String>{ 'Id' };
        Map<String, String> mergeMap = new Map<String, String>();
        if (mapping != null && String.isNotBlank(mapping.Merge_Map__c)) {
            Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(mapping.Merge_Map__c);
            for (String k : raw.keySet()) { String path = String.valueOf(raw.get(k)); mergeMap.put(k, path); paths.add(path); }
        }
        Map<String, Schema.SObjectField> fields = t.getDescribe().fields.getMap();
        if (fields.containsKey('name')) paths.add('Name');
        String contactField = mapping != null && String.isNotBlank(mapping.Signer_Contact_Field__c) ? mapping.Signer_Contact_Field__c : null;
        if (contactField != null) paths.add(contactField);
        SObject rec;
        try { rec = Database.query('SELECT ' + String.join(new List<String>(paths), ', ') + ' FROM ' + c.objectName + ' WHERE Id = :recordId WITH USER_MODE'); }
        catch (Exception e) { rec = Database.query('SELECT Id' + (fields.containsKey('name') ? ', Name' : '') + ' FROM ' + c.objectName + ' WHERE Id = :recordId WITH USER_MODE'); }
        c.recordName = fields.containsKey('name') && rec.get('Name') != null ? String.valueOf(rec.get('Name')) : String.valueOf(recordId);
        for (String key : mergeMap.keySet()) { Object v = resolve(rec, mergeMap.get(key)); c.mergeValues.put(key, v == null ? '' : format(v)); }
        c.suggestedTitle = mapping != null && String.isNotBlank(mapping.Title_Template__c) ? mapping.Title_Template__c.replace('{{Name}}', c.recordName) : c.recordName;
        if (c.objectName == 'Contact') { for (Contact ct : [SELECT Name, Email FROM Contact WHERE Id = :recordId]) add(c, ct.Name, ct.Email, 'This contact'); }
        else if (c.objectName == 'Account') { for (Contact ct : [SELECT Name, Email FROM Contact WHERE AccountId = :recordId AND Email != null ORDER BY Name LIMIT 50]) add(c, ct.Name, ct.Email, 'Account contact'); }
        else if (c.objectName == 'Opportunity') { for (OpportunityContactRole r : [SELECT Contact.Name, Contact.Email, Role FROM OpportunityContactRole WHERE OpportunityId = :recordId AND Contact.Email != null ORDER BY IsPrimary DESC LIMIT 50]) add(c, r.Contact.Name, r.Contact.Email, r.Role == null ? 'Contact role' : r.Role); }
        else if (c.objectName == 'Lead') { for (Lead l : [SELECT Name, Email FROM Lead WHERE Id = :recordId]) add(c, l.Name, l.Email, 'This lead'); }
        else if (c.objectName == 'Case') { for (Case cs : [SELECT Contact.Name, Contact.Email FROM Case WHERE Id = :recordId AND ContactId != null]) add(c, cs.Contact.Name, cs.Contact.Email, 'Case contact'); }
        if (contactField != null) {
            try { Id cid = (Id) rec.get(contactField); if (cid != null) { for (Contact ct : [SELECT Name, Email FROM Contact WHERE Id = :cid]) add(c, ct.Name, ct.Email, 'Mapped contact'); } } catch (Exception ignore) { System.debug(ignore); }
        }
        return c;
    }
    private static void add(Context c, String name, String email, String label) {
        if (String.isBlank(email)) return;
        for (Candidate x : c.contacts) if (x.email == email) return;
        Candidate cand = new Candidate(); cand.name = name; cand.email = email; cand.label = label; c.contacts.add(cand);
    }
    private static Object resolve(SObject rec, String path) {
        try {
            SObject cur = rec; List<String> parts = path.split('\\.');
            for (Integer i = 0; i < parts.size() - 1; i++) { cur = cur.getSObject(parts[i]); if (cur == null) return null; }
            return cur.get(parts[parts.size() - 1]);
        } catch (Exception e) { return null; }
    }
    private static String format(Object v) {
        if (v instanceof Date) return ((Date) v).format();
        if (v instanceof Datetime) return ((Datetime) v).format();
        if (v instanceof Decimal) { Decimal d = (Decimal) v; return d.setScale(d.scale() > 2 ? 2 : d.scale()).toPlainString(); }
        return String.valueOf(v);
    }
}
