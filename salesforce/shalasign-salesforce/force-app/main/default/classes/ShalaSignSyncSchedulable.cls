/** Runs every 15 minutes (scheduled from Setup): refreshes envelopes awaiting signature and attaches signed PDFs. */
global with sharing class ShalaSignSyncSchedulable implements Schedulable {
    global void execute(SchedulableContext sc) { System.enqueueJob(new ShalaSignSyncQueueable()); }
}
