import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readiness} from '../src/lib/payments';
import {fixture} from './helpers';

test('production keys and enabled switches open checkout with untouched launch defaults',async()=>{
 const f=fixture();try{
  const env={...f.env,GENERATION_ENABLED:'true',CHECKOUT_ENABLED:'true',USDC_ENABLED:'true',OPENROUTER_API_KEY:'fixture-only',STRIPE_SECRET_KEY:'fixture-only',STRIPE_WEBHOOK_SECRET:'fixture-only',AHAB_AVATAR_MAX_SECONDS_VERIFIED:'0',AHAB_AVATAR_VOICES:'[]'};
  const config=await readiness(env);
  assert.equal(config.generationEnabled,true);assert.equal(config.checkoutEnabled,true);
  assert.equal(config.maxPresenterDuration,120);assert.equal(config.voices.length,1);
  assert.equal(config.usdcEnabled,true);
  assert.equal(f.db.row<{funded_cents:number}>('SELECT funded_cents FROM provider_budget')!.funded_cents,0);
 }finally{f.close();}
});
test('missing credentials or an explicit off switch still explain blocked checkout',async()=>{
 const f=fixture();try{
  const env={...f.env,GENERATION_ENABLED:'true',CHECKOUT_ENABLED:'true',OPENROUTER_API_KEY:'fixture',STRIPE_SECRET_KEY:'fixture',STRIPE_WEBHOOK_SECRET:'fixture'};
  assert.equal((await readiness({...env,STRIPE_WEBHOOK_SECRET:undefined})).checkoutReason,'Payment setup is incomplete.');
  assert.equal((await readiness({...env,GENERATION_ENABLED:'false'})).checkoutEnabled,false);
  assert.equal((await readiness({...env,CHECKOUT_ENABLED:'false'})).checkoutReason,'Purchases are currently turned off.');
 }finally{f.close();}
});
