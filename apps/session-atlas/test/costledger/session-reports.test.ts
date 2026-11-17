import {test} from 'node:test'
import assert from 'node:assert/strict'
import {openTestLedger,insertTestMessage,FIXED_NOW} from '../helpers/costledger.ts'
import type {LedgerDb} from '../../src/costledger/db.ts'
import {reportTotal} from '../../src/costledger/reports.ts'
import {sessionRoots,sessionTree} from '../../src/costledger/session-reports.ts'

function node(db:LedgerDb,tool:string,s:string,a:string,ps:string|null,pa:string|null,kind:string){
 db.raw.prepare('INSERT INTO session_nodes(tool,source_session_id,source_agent_id,parent_session_id,parent_agent_id,kind,link_quality) VALUES(?,?,?,?,?,?,?)').run(tool,s,a,ps,pa,kind,'exact')
}
function price(db:LedgerDb,costs:Array<[number,number]>){
 const run=Number(db.raw.prepare('INSERT INTO pricing_runs(started_at) VALUES(?)').run(FIXED_NOW).lastInsertRowid)
 for(const [id,c] of costs) db.raw.prepare("INSERT INTO message_costs(run_id,message_id,pricing_status,computed_cost_usd) VALUES(?,?,'priced',?)").run(run,id,c)
}

test('depth-three family costs sum each node once',()=>{
 const db=openTestLedger(), agents=['','a','b','c']
 const ids=agents.map((a,i)=>insertTestMessage(db,{source_message_id:'m'+i,source_session_id:'root',source_agent_id:a||null,is_sidechain:i?1:0}))
 agents.forEach((a,i)=>db.raw.prepare('INSERT INTO session_nodes(tool,source_session_id,source_agent_id,parent_session_id,parent_agent_id,kind,link_quality) VALUES(?,?,?,?,?,?,?)').run('claude-code','root',a,i?'root':null,i?agents[i-1]??null:null,i?'subagent':'main','exact'))
 const run=Number(db.raw.prepare('INSERT INTO pricing_runs(started_at) VALUES(?)').run(FIXED_NOW).lastInsertRowid)
 ids.forEach((id,i)=>db.raw.prepare("INSERT INTO message_costs(run_id,message_id,pricing_status,computed_cost_usd) VALUES(?,?,'priced',?)").run(run,id,i+1))
 const [root]=sessionRoots(db)
 assert.deepEqual([root?.ownCostUsd,root?.familyCostUsd,root?.familyMessages],[1,10,4])
 assert.deepEqual(sessionTree(db,'claude-code','root').nodes.map(n=>[n.agentId,n.familyCostUsd]),[['',10],['a',9],['b',7],['c',4]])
 db.close()
})
test('window excludes older call and reports unpriced without pretending it is free',()=>{
 const db=openTestLedger()
 const old=insertTestMessage(db,{source_message_id:'old',source_session_id:'r',ts_utc:'2026-09-29T00:00:00.000Z'})
 const next=insertTestMessage(db,{source_message_id:'next',source_session_id:'r',ts_utc:'2026-10-01T00:00:00.000Z'})
 db.raw.prepare("INSERT INTO session_nodes(tool,source_session_id,source_agent_id,kind,link_quality) VALUES('claude-code','r','','main','exact')").run()
 const run=Number(db.raw.prepare('INSERT INTO pricing_runs(started_at) VALUES(?)').run(FIXED_NOW).lastInsertRowid)
 db.raw.prepare("INSERT INTO message_costs(run_id,message_id,pricing_status,computed_cost_usd) VALUES(?,?,'priced',1),(?,?,'missing_alias',NULL)").run(run,old,run,next)
 const [r]=sessionRoots(db,{from:'2026-10-01T00:00:00.000Z'})
 assert.deepEqual([r?.familyCostUsd,r?.unpricedMessages],[0,1])
 db.close()
})
test('root family costs equal the report total across OpenCode, Pi, Claude, unknown session, and a linked copy',()=>{
 const db=openTestLedger()
 const costs:Array<[number,number]>=[]
 const add=(tool:string,id:string,session:string|null,cost:number)=>costs.push([insertTestMessage(db,{tool,source_message_id:id,source_session_id:session}),cost])
 add('opencode','o1','oroot',1);add('opencode','o2','ochild',2);add('opencode','o3','ogrand',4)
 node(db,'opencode','oroot','',null,null,'main');node(db,'opencode','ochild','','oroot','','subagent');node(db,'opencode','ogrand','','ochild','','subagent')
 add('pi','p1','proot',8)
 node(db,'pi','proot','',null,null,'main')
 add('claude-code','u1',null,16)
 const canon=insertTestMessage(db,{source_message_id:'c1',source_session_id:'A'})
 costs.push([canon,32])
 node(db,'claude-code','A','',null,null,'main');node(db,'claude-code','B','',null,null,'main')
 db.raw.prepare("INSERT INTO message_holders(message_id,source_session_id,source_agent_id) VALUES(?,'A',''),(?,'B','')").run(canon,canon)
 db.raw.prepare("INSERT INTO session_links(tool,session_a,session_b,kind,shared_calls) VALUES('claude-code','A','B','shared_history',1)").run()
 price(db,costs)
 const roots=sessionRoots(db)
 const by=Object.fromEntries(roots.map(r=>[r.tool+':'+r.sessionId,r]))
 assert.deepEqual([by['opencode:oroot']?.ownCostUsd,by['opencode:oroot']?.familyCostUsd],[1,7])
 assert.equal(sessionTree(db,'opencode','oroot').nodes.length,3)
 assert.deepEqual([by['pi:proot']?.ownCostUsd,by['pi:proot']?.familyCostUsd],[8,8])
 assert.deepEqual([by['claude-code:']?.familyCostUsd,by['claude-code:']?.familyMessages],[16,1])
 assert.equal(by['claude-code:B'],undefined)
 const b=sessionTree(db,'claude-code','B')
 assert.deepEqual([b.root.familyCostUsd,b.root.sharedHistoryCostUsd],[0,32])
 assert.deepEqual([by['claude-code:A']?.familyCostUsd,by['claude-code:A']?.sharedHistoryCostUsd],[32,0])
 assert.deepEqual(sessionTree(db,'claude-code','A').links.map(l=>[l.kind,l.direction,l.from,l.to]),[['shared_history','undirected','A','B']])
 assert.equal(roots.reduce((t,r)=>t+r.familyCostUsd,0),reportTotal(db).costUsd)
 db.close()
})
test('a node whose parent node is absent is a root, so its cost still counts in the root-family sum',()=>{
 const db=openTestLedger()
 const ids=[insertTestMessage(db,{source_message_id:'m0',source_session_id:'r',source_agent_id:null}),insertTestMessage(db,{source_message_id:'m1',source_session_id:'r',source_agent_id:'a',is_sidechain:1})]
 node(db,'claude-code','r','',null,null,'main')
 node(db,'claude-code','r','a','r','ghost','subagent')
 price(db,[[ids[0]??0,1],[ids[1]??0,2]])
 const roots=sessionRoots(db)
 assert.equal(roots.reduce((s,x)=>s+x.familyCostUsd,0),reportTotal(db).costUsd)
 assert.equal(reportTotal(db).costUsd,3)
 db.close()
})
test('missing session id is rejected clearly',()=>{
 const db=openTestLedger()
 assert.throws(()=>sessionTree(db,'pi','nope'),/unknown session: pi nope/)
 db.close()
})
