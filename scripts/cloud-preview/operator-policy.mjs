import assert from 'node:assert/strict';
export function assertActionAllowed(rows,action,deploymentId) {
  const previous=kind=>rows.filter(r=>r.kind===kind);
  if(action==='recover') return;
  if(action==='deploy') {assert.ok(!previous('deploy-intent').length,'Deployment already attempted; reconcile manually, never retry from an empty listing');return;}
  assert.ok(deploymentId && !previous('removed').some(r=>r.id===deploymentId),'No active deployment');
  const scoped=rows.filter(r=>r.id===deploymentId);
  const success=kind=>scoped.some(r=>r.kind===kind && r.result?.status==='ok');
  if(action==='setup'||action==='run') {
    assert.ok(!scoped.some(r=>r.kind==='cleanup-intent'),'Cleanup started; do not create more resources');
    assert.ok(success(action==='setup'?'inspect-result':'setup-result'),'Required prior phase did not succeed');
  }
  if(action==='remove') {
    const lastWrite=scoped.findLastIndex(r=>['setup-intent','run-intent'].includes(r.kind));
    const cleanup=scoped.findLastIndex(r=>r.kind==='cleanup-result' && r.result?.status==='ok' && r.result.zeroResidue===true);
    assert.ok(cleanup>=0 && cleanup>lastWrite,'Cleanup must follow the latest resource write');
  } else assert.ok(previous(action+'-intent').length<(action==='cleanup'?2:1),'Invocation allowance exhausted');
}
