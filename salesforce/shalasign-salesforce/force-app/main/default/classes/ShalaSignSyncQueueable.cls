public with sharing class ShalaSignSyncQueueable implements Queueable, Database.AllowsCallouts {
    public void execute(QueueableContext qc) { ShalaSignService.syncOpen(40); }
}
