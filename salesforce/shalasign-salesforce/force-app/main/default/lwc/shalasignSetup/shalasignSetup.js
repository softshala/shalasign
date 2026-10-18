import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getStatus from '@salesforce/apex/ShalaSignSetupController.getStatus';
import connect from '@salesforce/apex/ShalaSignSetupController.connect';
import disconnect from '@salesforce/apex/ShalaSignSetupController.disconnect';
import scheduleSync from '@salesforce/apex/ShalaSignSetupController.scheduleSync';
import syncNow from '@salesforce/apex/ShalaSignSetupController.syncNow';

export default class ShalasignSetup extends LightningElement {
    @track status = { connected: false };
    apiKey = '';
    busy = false;
    get notConnected() { return !this.status.connected; }
    connectedCallback() { this.load(); }
    load() { getStatus().then((s) => { this.status = s; }).catch((e) => this.toast('Error', this.msg(e), 'error')); }
    handleKey(e) { this.apiKey = e.target.value; }
    async handleConnect() {
        this.busy = true;
        try { this.status = await connect({ apiKey: this.apiKey.trim() }); this.apiKey = ''; this.toast('Connected', `ShalaSign accepted the key. Connected as ${this.status.connectedAs}.`, 'success'); }
        catch (e) { this.toast('Could not connect', this.msg(e), 'error'); }
        finally { this.busy = false; }
    }
    async handleDisconnect() { try { this.status = await disconnect(); } catch (e) { this.toast('Error', this.msg(e), 'error'); } }
    async handleSchedule() { try { this.status = await scheduleSync(); this.toast('Scheduled', 'Envelopes will be refreshed every 15 minutes.', 'success'); } catch (e) { this.toast('Error', this.msg(e), 'error'); } }
    async handleSyncNow() { try { const n = await syncNow(); this.toast('Synced', `${n} envelope(s) refreshed.`, 'success'); } catch (e) { this.toast('Error', this.msg(e), 'error'); } }
    msg(e) { return (e && e.body && e.body.message) || (e && e.message) || String(e); }
    toast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
}
