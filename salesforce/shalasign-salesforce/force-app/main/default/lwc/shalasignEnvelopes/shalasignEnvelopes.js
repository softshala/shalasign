import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import listForRecord from '@salesforce/apex/ShalaSignSendController.listForRecord';
import refresh from '@salesforce/apex/ShalaSignSendController.refresh';
import remind from '@salesforce/apex/ShalaSignSendController.remind';
import voidEnvelope from '@salesforce/apex/ShalaSignSendController.voidEnvelope';

const LABELS = { draft: 'Draft', sent: 'Awaiting signature', completed: 'Completed', voided: 'Voided', declined: 'Declined', expired: 'Expired' };
const THEME = { completed: 'slds-theme_success', sent: 'slds-theme_warning', voided: 'slds-theme_error', declined: 'slds-theme_error', expired: 'slds-theme_error' };

export default class ShalasignEnvelopes extends LightningElement {
    @api recordId;
    @track rows = [];
    error = '';
    loaded = false;
    get empty() { return this.loaded && !this.rows.length; }
    connectedCallback() { this.load(); }
    load = async () => {
        try {
            const list = await listForRecord({ recordId: this.recordId });
            this.rows = list.map((r) => ({
                ...r,
                statusLabel: LABELS[r.Status__c] || r.Status__c,
                isSent: r.Status__c === 'sent',
                badgeClass: 'slds-badge slds-m-left_x-small ' + (THEME[r.Status__c] || ''),
                when: r.Completed_At__c ? `- completed ${new Date(r.Completed_At__c).toLocaleDateString()}` : r.Sent_At__c ? `- sent ${new Date(r.Sent_At__c).toLocaleDateString()}` : '',
                fileUrl: r.Signed_File_Id__c ? `/lightning/r/ContentDocument/${r.Signed_File_Id__c}/view` : null
            }));
            this.error = '';
        } catch (e) { this.error = this.msg(e); } finally { this.loaded = true; }
    };
    async handleSync(e) { try { await refresh({ envelopeId: e.currentTarget.dataset.id }); await this.load(); } catch (err) { this.toast('Error', this.msg(err), 'error'); } }
    async handleRemind(e) { try { await remind({ envelopeId: e.currentTarget.dataset.id }); this.toast('Reminder sent', 'Pending signers have been reminded.', 'success'); } catch (err) { this.toast('Error', this.msg(err), 'error'); } }
    async handleVoid(e) {
        // eslint-disable-next-line no-alert
        if (!window.confirm('Void this envelope? Signers will no longer be able to sign.')) return;
        try { await voidEnvelope({ envelopeId: e.currentTarget.dataset.id, reason: 'Voided from Salesforce' }); await this.load(); } catch (err) { this.toast('Error', this.msg(err), 'error'); }
    }
    handleOpen(e) { window.open(e.currentTarget.dataset.url, '_blank'); }
    msg(e) { return (e && e.body && e.body.message) || (e && e.message) || String(e); }
    toast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
}
