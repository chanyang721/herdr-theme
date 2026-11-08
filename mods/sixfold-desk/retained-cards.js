import {View,div} from 'gpui-kit';

const registry=globalThis.__sixfoldRetainedCardControllers??=new Map();
class RetainedCard extends View{
  init(props){this.controller=props.controller;this.id=props.id;}
  render(cx){
    const card=registry.get(this.controller)?.get(this.id);
    return card?.present&&card.build?card.build(cx):div();
  }
}

// Create from init(), with its AsyncContext. card/begin/end may run during a
// parent render; all native state changes are deferred to one finite task.
export function createRetainedCards(cx){
  const native=typeof cx?.new==='function'&&typeof cx?.notify==='function'&&typeof cx?.timer?.after==='function';
  if(!native)return {begin(){},card(_id,_signature,build){return build();},end(){},dispose(){}};
  const sequence=(globalThis.__sixfoldRetainedCardSequence??0)+1;
  globalThis.__sixfoldRetainedCardSequence=sequence;
  const key=`cards-${sequence}`,cards=new Map(),seen=new Set(),create=new Set(),dirty=new Set(),release=new Set();
  registry.set(key,cards);
  let disposed=false,wake=null;
  const drop=card=>{
    const entity=card.entity;card.entity=null;
    try{entity?.release?.();}catch{/* A source reload may already have released the native handle. */}
    finally{if(cards.get(card.id)===card&&!card.present)cards.delete(card.id);card.build=null;}
  };
  const flush=()=>{
    wake=null;
    for(const card of [...release]){
      release.delete(card);
      if(!card.present||disposed){create.delete(card);dirty.delete(card);drop(card);}
    }
    if(disposed){create.clear();dirty.clear();return;}
    let mounted=false;
    for(const card of [...create]){
      create.delete(card);
      if(!card.present||card.entity||!card.build)continue;
      card.entity=cx.new(RetainedCard,{controller:key,id:card.id});mounted=true;
      // Its first native render observes the latest closure and signature.
      dirty.delete(card);
    }
    for(const card of [...dirty]){
      dirty.delete(card);
      if(card.present&&card.entity)cx.notify(card.entity);
    }
    if(mounted)cx.notify();
  };
  const schedule=()=>{
    if(wake)return;
    try{wake=cx.timer.after(0,flush);}catch{
      // The source generation is already gone. Remove strong registry links;
      // that generation's native ownership cleanup releases its children.
      wake=null;registry.delete(key);
      for(const card of cards.values())card.build=null;
      cards.clear();create.clear();dirty.clear();release.clear();disposed=true;
    }
  };
  return {
    begin(){if(!disposed)seen.clear();},
    card(id,signature,build){
      if(typeof build!=='function')throw new TypeError('A fresh card builder is required');
      if(disposed)return build();
      id=String(id);seen.add(id);
      let card=cards.get(id);
      if(!card){card={id,signature,build,present:true,entity:null};cards.set(id,card);create.add(card);schedule();}
      else{
        card.build=build;card.present=true;release.delete(card);
        if(!Object.is(card.signature,signature)){card.signature=signature;if(card.entity)dirty.add(card);}
        if(!card.entity)create.add(card);
        if(create.has(card)||dirty.has(card))schedule();
      }
      return card.entity||build();
    },
    end(){
      if(disposed)return;
      for(const card of cards.values())if(!seen.has(card.id)){card.present=false;create.delete(card);dirty.delete(card);release.add(card);}
      if(release.size)schedule();
    },
    dispose(){
      if(disposed)return;disposed=true;registry.delete(key);
      create.clear();dirty.clear();
      for(const card of cards.values()){card.present=false;card.build=null;release.add(card);}
      if(release.size)schedule();
    },
  };
}
