import { MongoClient } from "mongodb";
import fs from "node:fs";
const vars = Object.fromEntries(fs.readFileSync("../manaramp/.dev.vars","utf8").split(/\r?\n/).filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
const c = await MongoClient.connect(vars.MONGODB_READONLY_URI_PROD);
const cards = c.db().collection("cards");
const v = (x) => Array.isArray(x) ? x.map(y => y.modifiers?.length ? `${y.type}.${y.modifiers.join("+")}` : y.type).join(",") : x;
const walk = (steps, out, d=0) => { for (const s of steps) { out.push("  ".repeat(d) + `${s.effect} ${s.zone_change ? `[${v(s.zone_change.from)}->${v(s.zone_change.to)} what=${v(s.zone_change.what)}]` : ""} ` + Object.entries(s.params||{}).filter(([k])=>!/Desc|Remember|Forget|SpellDescription|StackDescription|AILogic|Shuffle|NoLooking|Reveal|Mandatory/.test(k)).map(([k,x])=>`${k}=${v(x)}`).join(" ")); for (const [k,ch] of Object.entries(s.choices||{})) { out.push("  ".repeat(d+1)+"choice "+k); walk(ch,out,d+2);} for (const n of s.nested_effects||[]) walk(n.result,out,d+1); if (s.branch) { walk(s.branch.true_result,out,d+1); walk(s.branch.false_result,out,d+1);} } };
for (const n of process.argv.slice(2)) {
  const d = await cards.findOne({ name: n }, { projection: { type_line: 1, effects: 1 } });
  if (!d) { console.log("MISSING", n); continue; }
  console.log(`== ${n} (${d.type_line})`);
  for (const e of d.effects) { const out=[]; walk(e.result,out); console.log(` ${e.trigger.kind}${e.trigger.mode?"/"+e.trigger.mode:""} cost=${(e.trigger.cost||[]).map(p=>p.kind).join("+")}`); console.log(out.map(l=>"   "+l).join("\n")); }
}
await c.close();
