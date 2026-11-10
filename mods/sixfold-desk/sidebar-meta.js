// Sidebar space cards: display order and where a card's badges sit.
import {shared} from 'herdr';
import {orderWorkspaceGroups} from './workspace-order.js';
import {badgesFor,badgeKey,BADGES_KEY,workspaceBadges} from './badges.js';

export function spaceBadges(view,space){return badgesFor(badgeKey(space.machine??null,space.id),view.fileBadges,shared(BADGES_KEY));}
// A badge with a state (blocked, working…) belongs on the meta line; a plain
// launcher ('기억') fits in the header and needs no line of its own.
export const lineBadges=badges=>badges.some(badge=>badge.tone!=='dim');
// The retained task card's hook: its native space's badges for the meta line, or null.
export const metaBadges=view=>native=>{
  const list=spaceBadges(view,native);
  return lineBadges(list)?{key:list,view:t=>workspaceBadges(view,native,t)}:null;
};
// Working = a pane working now, or a task agent working that is not being closed.
export function spaceWorking(members,task){
  return members.some(p=>p.status==='working')||Boolean(task?.agents?.some(agent=>agent.status==='working'&&!agent.closing));
}
// Pinned spaces first, then those working now, then the rest; each keeps the
// native order. Display only: never moves or closes a workspace.
export function orderSpaceCards(groups,isPinned,taskFor){
  return orderWorkspaceGroups(groups,isPinned,group=>spaceWorking(group.members,taskFor(group.s)));
}
