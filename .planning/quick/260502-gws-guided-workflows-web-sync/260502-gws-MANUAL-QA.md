# Manual QA Checklist

## Desktop Creation

- [ ] Create Freestyle project: blank starter story is unchanged and no roadmap panel appears.
- [ ] Create each guided workflow type: starter story parses, roadmap panel appears, status changes persist after reopen.
- [ ] Creation hub at desktop width: no clipped labels, overlapped cards, or nested-card clutter.
- [ ] Creation hub at narrow width: cards and inputs remain readable without horizontal scrolling.

## Editor Roadmap

- [ ] UI Builder shows roadmap above scene editing for guided projects.
- [ ] Status buttons update `todo`, `drafted`, `recorded`, and `polished`.
- [ ] Roadmap panel does not crowd scene editing or simulator controls.

## Web Companion

- [ ] Template marketplace shows workflow type, best-for, duration, and polish preset.
- [ ] Forking a workflow template returns `.story` source plus workflow metadata.
- [ ] Synced guided project displays workflow type and status counts.
- [ ] Synced project story source remains read-only.

## Offline Sync

- [ ] Sync while offline queues payload with workflow metadata.
- [ ] Flush after reconnect sends queued workflow metadata to web.
