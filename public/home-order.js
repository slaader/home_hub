// Saving the Přehled tile order (home-view.js → POST /api/profile/home-order). No DOM here, so the
// ordering rules are testable in node (tests/home-order-ui.test.mjs).
//  - Every move is shown at once (optimistic) and saved; saves run one at a time. A move made while a
//    save is in flight waits and replaces any move still waiting, so only the newest order is sent and
//    responses can never arrive out of order.
//  - A failed save goes back to the last order the server confirmed, and only when no newer move is
//    waiting: an obsolete failure never undoes a newer reorder.
//  - Everything is bound to the sign-in that made the move. After a sign-out or account switch nothing
//    waiting is sent, and no completion, rollback or note reaches the next account's cache or screen.
import {sessionTicket} from './session-cache.js';

// cache: a sessionCache holding {order,available} under ''. send(order) → Promise<{order,available}>.
// save(order) resolves to 'saved' | 'failed' (rolled back) | 'superseded' (a newer move took over)
// | 'stale' (the sign-in changed; the caller must not touch the screen).
export function createOrderSaver({cache,send,ticket=sessionTicket}){
 let run=null;// {live,store,confirmed,busy,queued} for the current sign-in while saves are pending
 const optimistic=order=>({order:order.length?order:null,available:true});
 async function pump(s){
  while(s.queued){
   const {order,done}=s.queued;s.queued=null;
   if(!s.live()){done('stale');continue;}
   let value=null;try{value=await send(order);}catch{}
   if(!s.live()){done('stale');continue;}
   if(value)s.confirmed=value;
   if(s.queued){done('superseded');continue;}
   if(value||s.confirmed)s.store('',value||s.confirmed);// newest outcome: the server's order, or back to the last confirmed one
   done(value?'saved':'failed');
  }
  s.busy=false;if(run===s)run=null;
 }
 return {
  save(order){
   if(!run||!run.live())run={live:ticket(),store:cache.begin(),confirmed:cache.get(),busy:false,queued:null};
   const s=run;
   s.store('',optimistic(order));
   return new Promise(done=>{
    s.queued?.done('superseded');
    s.queued={order,done};
    if(!s.busy){s.busy=true;pump(s);}
   });
  }
 };
}
