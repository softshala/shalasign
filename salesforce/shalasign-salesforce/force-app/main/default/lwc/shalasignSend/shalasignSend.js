import { LightningElement, api, track } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { getRecordNotifyChange } from 'lightning/uiRecordApi';
import getTemplates from '@salesforce/apex/ShalaSignSendController.getTemplates';
import getTemplate from '@salesforce/apex/ShalaSignSendController.getTemplate';
import getContext from '@salesforce/apex/ShalaSignSendController.getContext';
import send from '@salesforce/apex/ShalaSignSendController.send';

export default class ShalasignSend extends LightningElement {
    @api recordId;
    @track templates = [];
    @track template;
    @track ctx;
    @track signerRows = [];
    @track mergeRows = [];
    templateId = '';
    title = '';
    message = '';
    error = '';
    loading = true;
    sending = false;

    connectedCallback() {
        Promise.all([getTemplates(), getContext({ recordId: this.recordId, templateId: null })])
            .then(([t, c]) => {
                this.templates = t; this.ctx = c;
                if (c.mappedTemplateId && t.some((x) => x.id === c.mappedTemplateId)) { this.templateId = c.mappedTemplateId; return this.loadTemplate(); }
                return null;
            })
            .catch((e) => { this.error = this.msg(e); })
            .finally(() => { this.loading = false; });
    }
    get templateOptions() { return this.templates.map((t) => ({ label: `${t.name} (${(t.roles || []).map((r) => r.name).join(', ')})`, value: t.id })); }
    get contactOptions() { return [{ label: 'Type manually', value: '' }, ...((this.ctx && this.ctx.contacts) || []).map((c) => ({ label: `${c.name} - ${c.email} (${c.label})`, value: c.email }))]; }
    get hasMerge() { return this.mergeRows.length > 0; }
    get cannotSend() { return this.sending || !this.template || this.signerRows.some((r) => !r.name || !r.email); }
    async handleTemplate(e) {
        this.templateId = e.detail.value; this.error = ''; this.loading = true;
        try { await this.loadTemplate(); } catch (err) { this.error = this.msg(err); } finally { this.loading = false; }
    }
    async loadTemplate() {
        const [t, c] = await Promise.all([getTemplate({ templateId: this.templateId }), getContext({ recordId: this.recordId, templateId: this.templateId })]);
        this.template = t; this.ctx = c; this.title = c.suggestedTitle || t.name;
        const first = c.contacts && c.contacts[0];
        this.signerRows = (t.roles && t.roles.length ? t.roles : [{ name: 'Signer' }]).map((r, i) => ({
            index: i, role: r.name || `Signer ${i + 1}`,
            pick: i === 0 && first ? first.email : '', name: i === 0 && first ? first.name : '', email: i === 0 && first ? first.email : ''
        }));
        const keys = [...new Set((t.fields || []).map((f) => f.merge_key).filter(Boolean))].filter((k) => !['name', 'email'].includes(k.toLowerCase()));
        this.mergeRows = keys.map((k) => ({ key: k, label: `{{${k}}}`, value: (c.mergeValues && c.mergeValues[k]) || '' }));
    }
    handleTitle(e) { this.title = e.target.value; }
    handleMessage(e) { this.message = e.target.value; }
    handlePick(e) {
        const i = Number(e.target.dataset.index); const email = e.detail.value;
        const c = ((this.ctx && this.ctx.contacts) || []).find((x) => x.email === email);
        this.signerRows = this.signerRows.map((r) => (r.index === i ? { ...r, pick: email, name: c ? c.name : r.name, email: c ? c.email : r.email } : r));
    }
    handleSigner(e) {
        const i = Number(e.target.dataset.index); const f = e.target.dataset.field; const v = e.target.value;
        this.signerRows = this.signerRows.map((r) => (r.index === i ? { ...r, [f]: v, pick: f === 'email' ? '' : r.pick } : r));
    }
    handleMerge(e) { const k = e.target.dataset.key; const v = e.target.value; this.mergeRows = this.mergeRows.map((m) => (m.key === k ? { ...m, value: v } : m)); }
    handleCancel() { this.dispatchEvent(new CloseActionScreenEvent()); }
    async handleSend() {
        this.sending = true; this.error = '';
        try {
            const merge = {}; this.mergeRows.forEach((m) => { merge[m.key] = m.value; });
            const env = await send({ requestJson: JSON.stringify({ templateId: this.templateId, recordId: this.recordId, title: this.title, message: this.message, signers: this.signerRows.map((r) => ({ name: r.name, email: r.email, role: r.role })), mergeData: merge }) });
            this.dispatchEvent(new ShowToastEvent({ title: 'Sent for signature', message: `${env.Name} is on its way to ${this.signerRows.map((r) => r.email).join(', ')}.`, variant: 'success' }));
            getRecordNotifyChange([{ recordId: this.recordId }]);
            this.dispatchEvent(new CloseActionScreenEvent());
        } catch (e) { this.error = this.msg(e); } finally { this.sending = false; }
    }
    msg(e) { return (e && e.body && e.body.message) || (e && e.message) || String(e); }
}
