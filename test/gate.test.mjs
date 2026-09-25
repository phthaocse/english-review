import { launch } from './cdp.mjs';
const BASE = process.env.BASE || 'http://localhost:8731';
let pass=0, fail=0;
const ok=(n,c,x='')=>{c?pass++:(fail++,console.log('  FAIL:',n,x));};
const eq=(n,a,b)=>ok(n,a===b,`got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== signed out: every route shows the gate ==');
{
  const B = await launch();
  for (const route of ['review','lookup','progress','capture','item/go%20off']) {
    await B.goto(`${BASE}/#/${route}`);
    await B.evaluate(`await new Promise(r=>setTimeout(r,900));`);
    const r = await B.evaluate(`return {
      gate: !!document.querySelector('.gate'),
      leaked: !!document.querySelector('.result, .quiz, .statgrid, .item-term, #type-form'),
    };`);
    ok(`#/${route} shows the gate`, r.gate, JSON.stringify(r));
    ok(`#/${route} leaks no content`, !r.leaked);
  }
  B.close();
}

console.log('== signed in: everything opens ==');
{
  const B = await launch();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({alg:'RS256'})}.${b64({email:'thaop@ghn.vn',name:'Thao',exp:Math.floor(Date.now()/1000)+7200,sub:'1'})}.sig`;
  await B.addInitScript(`
    sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
    const real = window.fetch;
    window.fetch = async (u, i={}) => String(u).includes('workers.dev')
      ? new Response(JSON.stringify({items:[]}), {status:200,headers:{'Content-Type':'application/json'}})
      : real(u, i);
  `);
  for (const [route, sel] of [['review','.statgrid'],['lookup','.result'],['progress','.bars'],['capture','#type-form']]) {
    await B.goto(`${BASE}/#/${route}`);
    await B.evaluate(`await new Promise(r=>setTimeout(r,700));`);
    const r = await B.evaluate(`return { has: !!document.querySelector('${sel}'), gate: !!document.querySelector('.gate'),
                                         acct: document.querySelector('#account-bar')?.textContent || '' };`);
    ok(`#/${route} renders`, r.has, JSON.stringify(r));
    ok(`#/${route} no gate`, !r.gate);
    ok(`#/${route} shows the account`, r.acct.includes('thaop@ghn.vn'), r.acct);
  }

  console.log('== signing out returns to the gate ==');
  const out = await B.evaluate(`
    document.querySelector('#global-signout').click();
    await new Promise(r=>setTimeout(r,400));
    return { gate: !!document.querySelector('.gate'), bar: !!document.querySelector('#account-bar'),
             stored: sessionStorage.getItem('knowledge/idtoken') };
  `);
  ok('gate returns', out.gate);
  ok('account bar removed', !out.bar);
  eq('token cleared', out.stored, null);
  B.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
