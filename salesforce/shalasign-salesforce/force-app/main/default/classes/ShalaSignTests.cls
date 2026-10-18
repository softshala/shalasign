@IsTest
private class ShalaSignTests {
    /** A System Administrator with the ShalaSign Admin permission set, like a real installer. */
    static User admin() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'System Administrator' LIMIT 1];
        User u = new User(Alias = 'ssadm', Email = 'ssadm@example.com', EmailEncodingKey = 'UTF-8', LastName = 'Admin', LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US', ProfileId = p.Id, TimeZoneSidKey = 'Asia/Kolkata', UserName = 'ssadm' + System.currentTimeMillis() + '@example.com');
        insert u;
        insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'ShalaSign_Admin'].Id);
        return u;
    }
    static void connect() { insert new ShalaSign_Settings__c(SetupOwnerId = UserInfo.getOrganizationId(), API_Key__c = 'sf_live_test'); }

    @IsTest static void setupConnectAndStatus() {
        User u = admin();
        System.runAs(u) {
            ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            Test.startTest();
            Map<String, Object> st = ShalaSignSetupController.getStatus(); System.assertEquals(false, st.get('connected'));
            st = ShalaSignSetupController.connect('sf_live_abc');
            System.assertEquals(true, st.get('connected'));
            System.assert(String.valueOf(st.get('connectedAs')).contains('s@softshala.com'));
            System.assertEquals('..._abc', String.valueOf(st.get('keyHint')));
            st = ShalaSignSetupController.scheduleSync(); System.assertEquals(true, st.get('syncScheduled'));
            System.assertEquals(4, [SELECT COUNT() FROM CronTrigger WHERE CronJobDetail.Name LIKE 'ShalaSign status sync%']);
            st = ShalaSignSetupController.disconnect(); System.assertEquals(false, st.get('connected'));
            Test.stopTest();
        }
    }

    @IsTest static void connectRejectsBadKey() {
        User u = admin();
        System.runAs(u) {
            ShalaSignMock m = new ShalaSignMock(); m.failAuth = true; Test.setMock(HttpCalloutMock.class, m);
            String msg;
            Test.startTest();
            try { ShalaSignSetupController.connect('bad'); } catch (AuraHandledException e) { msg = e.getMessage(); }
            System.assert(msg != null && msg.contains('rejected'), 'bad key must be rejected: ' + msg);
            // Not connected: every API call explains what to do
            try { ShalaSignSendController.getTemplates(); System.assert(false, 'should throw'); } catch (AuraHandledException e) { System.assert(e.getMessage().contains('not connected'), e.getMessage()); }
            Test.stopTest();
        }
    }

    @IsTest static void sendFromTemplate() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            Account a = new Account(Name = 'Acme'); insert a;
            Contact c = new Contact(FirstName = 'Asha', LastName = 'Verma', Email = 'a@x.com', AccountId = a.Id); insert c;
            Test.startTest();
            ShalaSignRecordContext.Context ctx = ShalaSignSendController.getContext(a.Id, 'tpl1');
            System.assertEquals('Account', ctx.objectName); System.assertEquals(1, ctx.contacts.size()); System.assertEquals('Acme', ctx.suggestedTitle);
            ShalaSignRecordContext.Context cctx = ShalaSignSendController.getContext(c.Id, null); System.assertEquals('a@x.com', cctx.contacts[0].email);
            List<Object> tpls = ShalaSignSendController.getTemplates(); System.assertEquals(1, tpls.size());
            Map<String, Object> tpl = ShalaSignSendController.getTemplate('tpl1'); System.assertEquals('Standard NDA', tpl.get('name'));
            ShalaSignService.SendRequest r = new ShalaSignService.SendRequest();
            r.templateId = 'tpl1'; r.recordId = a.Id; r.title = 'NDA Acme'; r.signers = new List<ShalaSignService.Signer>();
            ShalaSignService.Signer s = new ShalaSignService.Signer(); s.name = 'Asha Verma'; s.email = 'a@x.com'; r.signers.add(s);
            r.mergeData = new Map<String, String>{ 'Company' => 'Acme' };
            ShalaSign_Envelope__c env = ShalaSignSendController.send(JSON.serialize(r));
            Test.stopTest();
            System.assertEquals('env1', env.ShalaSign_Id__c); System.assertEquals('sent', env.Status__c); System.assertEquals(a.Id, env.Account__c); System.assertEquals('Standard NDA', env.Template_Name__c);
            System.assert(m.sendBody.contains('"external_id":"' + a.Id + '"'), 'external reference must be sent: ' + m.sendBody);
            System.assert(m.sendBody.contains('"Company":"Acme"'), 'merge data must be sent: ' + m.sendBody);
            List<ShalaSign_Envelope__c> list1 = ShalaSignSendController.listForRecord(a.Id); System.assertEquals(1, list1.size());
        }
    }

    @IsTest static void remindAndRefreshAttachesSignedPdf() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            Account a = new Account(Name = 'Acme'); insert a;
            ShalaSign_Envelope__c env = new ShalaSign_Envelope__c(Name = 'NDA', ShalaSign_Id__c = 'env1', Status__c = 'sent', Record_Id__c = a.Id, Account__c = a.Id); insert env;
            Test.startTest();
            ShalaSignSendController.remind(env.Id);
            System.assert(m.lastPath.endsWith('/api/envelopes/env1/remind'), m.lastPath);
            m.status = 'completed';
            env = ShalaSignSendController.refresh(env.Id);
            Test.stopTest();
            System.assertEquals('completed', env.Status__c); System.assertNotEquals(null, env.Completed_At__c);
            System.assertNotEquals(null, env.Signed_File_Id__c, 'signed PDF attached');
            System.assertEquals(1, [SELECT COUNT() FROM ContentDocumentLink WHERE LinkedEntityId = :a.Id]);
            System.assert(env.Signer_Summary__c.contains('Asha (signed)'), env.Signer_Summary__c);
        }
    }

    @IsTest static void refreshDoesNotAttachTwice() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); m.status = 'completed'; Test.setMock(HttpCalloutMock.class, m);
            Account a = new Account(Name = 'Acme'); insert a;
            ShalaSign_Envelope__c env = new ShalaSign_Envelope__c(Name = 'NDA', ShalaSign_Id__c = 'env1', Status__c = 'completed', Record_Id__c = a.Id, Signed_File_Id__c = '069000000000001'); insert env;
            Test.startTest();
            env = ShalaSignSendController.refresh(env.Id);
            Test.stopTest();
            System.assertEquals(1, m.calls, 'no download when the file already exists');
            System.assertEquals('069000000000001', env.Signed_File_Id__c);
            System.assertEquals(0, [SELECT COUNT() FROM ContentDocumentLink WHERE LinkedEntityId = :a.Id]);
        }
    }

    @IsTest static void contextForStandardObjects() {
        User u = admin();
        System.runAs(u) {
            Account a = new Account(Name = 'Acme'); insert a;
            Contact c = new Contact(FirstName = 'Asha', LastName = 'Verma', Email = 'a@x.com', AccountId = a.Id); insert c;
            Opportunity o = new Opportunity(Name = 'Deal', StageName = 'Prospecting', CloseDate = Date.today(), AccountId = a.Id); insert o;
            insert new OpportunityContactRole(OpportunityId = o.Id, ContactId = c.Id, Role = 'Decision Maker', IsPrimary = true);
            Lead l = new Lead(LastName = 'Lee', Company = 'Globex', Email = 'lee@x.com'); insert l;
            Case cs = new Case(Subject = 'Help', ContactId = c.Id); insert cs;
            System.assertEquals('Decision Maker', ShalaSignRecordContext.build(o.Id, null).contacts[0].label);
            System.assertEquals('lee@x.com', ShalaSignRecordContext.build(l.Id, null).contacts[0].email);
            System.assertEquals('Case contact', ShalaSignRecordContext.build(cs.Id, null).contacts[0].label);
            System.assertEquals(0, ShalaSignRecordContext.build(cs.Id, null).mergeValues.size());
        }
    }

    @IsTest static void signerCountMustMatchTemplate() {
        User u = admin();
        System.runAs(u) {
            connect(); Test.setMock(HttpCalloutMock.class, new ShalaSignMock());
            Account a = new Account(Name = 'Acme'); insert a;
            ShalaSignService.SendRequest r = new ShalaSignService.SendRequest();
            r.templateId = 'tpl1'; r.recordId = a.Id; r.signers = new List<ShalaSignService.Signer>();
            String msg;
            Test.startTest();
            try { ShalaSignSendController.send(JSON.serialize(r)); } catch (AuraHandledException e) { msg = e.getMessage(); }
            Test.stopTest();
            System.assert(msg != null && msg.contains('signer'), msg);
        }
    }

    @IsTest static void voidEnvelope() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            ShalaSign_Envelope__c env = new ShalaSign_Envelope__c(Name = 'NDA', ShalaSign_Id__c = 'env1', Status__c = 'sent'); insert env;
            Test.startTest();
            ShalaSignSendController.voidEnvelope(env.Id, 'typo');
            Test.stopTest();
            env = [SELECT Status__c FROM ShalaSign_Envelope__c WHERE Id = :env.Id]; System.assertEquals('voided', env.Status__c);
        }
    }

    @IsTest static void syncNowRefreshesOpenEnvelopes() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            insert new ShalaSign_Envelope__c(Name = 'NDA', ShalaSign_Id__c = 'env1', Status__c = 'sent');
            insert new ShalaSign_Envelope__c(Name = 'Gone', ShalaSign_Id__c = 'missing', Status__c = 'sent');
            Test.startTest();
            Integer n = ShalaSignSetupController.syncNow();
            Test.stopTest();
            System.assertEquals(1, n, 'one envelope refreshed, one failed');
            ShalaSign_Envelope__c bad = [SELECT Error__c, Last_Synced__c FROM ShalaSign_Envelope__c WHERE ShalaSign_Id__c = 'missing'];
            System.assert(bad.Error__c != null && bad.Last_Synced__c != null, 'failure recorded on the record');
        }
    }

    @IsTest static void scheduledJobRunsQueueable() {
        User u = admin();
        System.runAs(u) {
            connect(); Test.setMock(HttpCalloutMock.class, new ShalaSignMock());
            insert new ShalaSign_Envelope__c(Name = 'NDA', ShalaSign_Id__c = 'env1', Status__c = 'sent');
            Test.startTest();
            new ShalaSignSyncSchedulable().execute(null);
            System.assertEquals(1, [SELECT COUNT() FROM AsyncApexJob WHERE JobType = 'Queueable']);
            Test.stopTest();
            System.assertNotEquals(null, [SELECT Last_Synced__c FROM ShalaSign_Envelope__c WHERE ShalaSign_Id__c = 'env1'].Last_Synced__c);
        }
    }

    @IsTest static void invocableSendsWithMapping() {
        User u = admin();
        System.runAs(u) {
            connect(); ShalaSignMock m = new ShalaSignMock(); Test.setMock(HttpCalloutMock.class, m);
            Opportunity o = new Opportunity(Name = 'Big deal', StageName = 'Prospecting', CloseDate = Date.today(), Amount = 1200000); insert o;
            ShalaSignSendInvocable.Request q = new ShalaSignSendInvocable.Request();
            q.templateId = 'tpl1'; q.recordId = o.Id; q.signerName = 'Rohit'; q.signerEmail = 'r@x.com'; q.mergeJson = '{"Company":"Globex"}';
            ShalaSignSendInvocable.Request q2 = new ShalaSignSendInvocable.Request();
            q2.templateId = 'tpl1'; q2.recordId = o.Id; q2.signerName = 'Rohit'; q2.signerEmail = 'r@x.com'; q2.signer2Name = 'Extra'; q2.signer2Email = 'e@x.com';
            Test.startTest();
            List<ShalaSignSendInvocable.Result> res = ShalaSignSendInvocable.send(new List<ShalaSignSendInvocable.Request>{ q, q2 });
            Test.stopTest();
            System.assertEquals(null, res[0].error, 'first request should succeed: ' + res[0].error); System.assertEquals('env1', res[0].shalasignId);
            System.assertEquals(o.Id, [SELECT Opportunity__c FROM ShalaSign_Envelope__c WHERE Id = :res[0].envelopeRecordId].Opportunity__c);
            System.assert(res[1].error != null && res[1].error.contains('needs 1 signer'), 'second request has too many signers: ' + res[1].error);
        }
    }

    @IsTest static void parseDateHandlesFormats() {
        System.assertNotEquals(null, ShalaSignService.parseDate('2026-10-18 10:00:00'));
        System.assertEquals(null, ShalaSignService.parseDate(null));
        System.assertEquals(null, ShalaSignService.parseDate('garbage'));
    }
}
