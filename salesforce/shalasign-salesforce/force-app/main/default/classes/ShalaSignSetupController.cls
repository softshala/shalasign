public with sharing class ShalaSignSetupController {
    @AuraEnabled
    public static Map<String, Object> getStatus() {
        ShalaSign_Settings__c s = ShalaSign_Settings__c.getOrgDefaults();
        Map<String, Object> out = new Map<String, Object>();
        out.put('connected', s != null && String.isNotBlank(s.API_Key__c));
        out.put('connectedAs', s == null ? null : s.Connected_As__c);
        out.put('syncScheduled', s != null && s.Sync_Scheduled__c == true);
        out.put('keyHint', s == null || String.isBlank(s.API_Key__c) ? null : '...' + s.API_Key__c.right(4));
        return out;
    }
    /** Save the key only if ShalaSign accepts it. */
    @AuraEnabled
    public static Map<String, Object> connect(String apiKey) {
        try {
            ShalaSignClient.overrideKey = apiKey;
            Map<String, Object> me = ShalaSignClient.me();
            ShalaSignClient.overrideKey = null;
            ShalaSign_Settings__c s = ShalaSign_Settings__c.getOrgDefaults();
            if (s == null) s = new ShalaSign_Settings__c(SetupOwnerId = UserInfo.getOrganizationId());
            s.API_Key__c = apiKey; s.Connected_As__c = String.valueOf(me.get('name')) + ' <' + String.valueOf(me.get('email')) + '>';
            upsert s;
            return getStatus();
        } catch (Exception e) { ShalaSignClient.overrideKey = null; throw ShalaSignClient.aura(e); }
    }
    @AuraEnabled
    public static Map<String, Object> disconnect() {
        ShalaSign_Settings__c s = ShalaSign_Settings__c.getOrgDefaults();
        if (s != null && s.Id != null) { s.API_Key__c = null; s.Connected_As__c = null; update s; }
        return getStatus();
    }
    @AuraEnabled
    public static Map<String, Object> scheduleSync() {
        try {
            for (CronTrigger ct : [SELECT Id FROM CronTrigger WHERE CronJobDetail.Name LIKE 'ShalaSign status sync%']) System.abortJob(ct.Id);
            for (Integer m : new List<Integer>{ 0, 15, 30, 45 }) System.schedule('ShalaSign status sync :' + m, '0 ' + m + ' * * * ?', new ShalaSignSyncSchedulable());
            ShalaSign_Settings__c s = ShalaSign_Settings__c.getOrgDefaults();
            if (s == null) s = new ShalaSign_Settings__c(SetupOwnerId = UserInfo.getOrganizationId());
            s.Sync_Scheduled__c = true; upsert s;
            return getStatus();
        } catch (Exception e) { throw ShalaSignClient.aura(e); }
    }
    @AuraEnabled
    public static Integer syncNow() { try { return ShalaSignService.syncOpen(40); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
}
