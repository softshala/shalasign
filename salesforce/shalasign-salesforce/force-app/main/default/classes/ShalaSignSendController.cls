public with sharing class ShalaSignSendController {
    @AuraEnabled(cacheable=true)
    public static List<Object> getTemplates() { try { return ShalaSignClient.listTemplates(); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getTemplate(String templateId) { try { return ShalaSignClient.getTemplate(templateId); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
    @AuraEnabled(cacheable=true)
    public static ShalaSignRecordContext.Context getContext(Id recordId, String templateId) { try { return ShalaSignRecordContext.build(recordId, templateId); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
    @AuraEnabled
    public static ShalaSign_Envelope__c send(String requestJson) {
        try { ShalaSignService.SendRequest r = (ShalaSignService.SendRequest) JSON.deserialize(requestJson, ShalaSignService.SendRequest.class); return ShalaSignService.sendFromTemplate(r); }
        catch (Exception e) { throw ShalaSignClient.aura(e); }
    }
    @AuraEnabled
    public static List<ShalaSign_Envelope__c> listForRecord(Id recordId) {
        return [SELECT Id, Name, ShalaSign_Id__c, Status__c, Signer_Summary__c, Sent_At__c, Completed_At__c, Expires_At__c, Open_Url__c, Template_Name__c, Last_Synced__c, Signed_File_Id__c, Error__c FROM ShalaSign_Envelope__c WHERE Record_Id__c = :recordId WITH USER_MODE ORDER BY CreatedDate DESC LIMIT 50];
    }
    @AuraEnabled
    public static ShalaSign_Envelope__c refresh(Id envelopeId) { try { return ShalaSignService.sync(envelopeId); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
    @AuraEnabled
    public static void remind(Id envelopeId) { try { ShalaSign_Envelope__c env = [SELECT ShalaSign_Id__c FROM ShalaSign_Envelope__c WHERE Id = :envelopeId]; ShalaSignClient.remind(env.ShalaSign_Id__c); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
    @AuraEnabled
    public static void voidEnvelope(Id envelopeId, String reason) { try { ShalaSign_Envelope__c env = [SELECT ShalaSign_Id__c FROM ShalaSign_Envelope__c WHERE Id = :envelopeId]; ShalaSignClient.voidEnvelope(env.ShalaSign_Id__c, reason); ShalaSignService.sync(envelopeId); } catch (Exception e) { throw ShalaSignClient.aura(e); } }
}
