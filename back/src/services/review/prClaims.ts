import type { PublicUser } from "../../auth/users.js";

export interface PrClaim {
  prNumber: number;
  userId: string;
  username: string;
}

export type PrLiveEvent =
  | { type: "claims"; claims: PrClaim[] }
  | { type: "pulls-changed" };

interface Viewer {
  send: (event: PrLiveEvent) => void;
}

interface Room {
  viewers: Set<Viewer>;
  holders: Map<number, { claim: PrClaim; viewer: Viewer }>;
}

export interface PrRoomSeat {
  claim: (prNumber: number) => PrClaim;
  release: (prNumber: number) => void;
  leave: () => void;
}

const rooms = new Map<string, Room>();

function claimsOf(room: Room): PrClaim[] {
  return [...room.holders.values()].map((holder) => holder.claim);
}

function broadcast(room: Room, event: PrLiveEvent): void {
  for (const viewer of room.viewers) viewer.send(event);
}

export function joinPrRoom(projectId: string, user: PublicUser, send: (event: PrLiveEvent) => void): PrRoomSeat {
  const room = rooms.get(projectId) ?? { viewers: new Set<Viewer>(), holders: new Map() };
  rooms.set(projectId, room);
  const viewer: Viewer = { send };
  room.viewers.add(viewer);
  send({ type: "claims", claims: claimsOf(room) });

  const release = (prNumber: number): void => {
    if (room.holders.get(prNumber)?.viewer !== viewer) return;
    room.holders.delete(prNumber);
    broadcast(room, { type: "claims", claims: claimsOf(room) });
  };
  return {
    claim: (prNumber) => {
      const current = room.holders.get(prNumber);
      if (current && current.claim.userId !== user.id) return current.claim;
      const claim = { prNumber, userId: user.id, username: user.username };
      room.holders.set(prNumber, { claim, viewer });
      broadcast(room, { type: "claims", claims: claimsOf(room) });
      return claim;
    },
    release,
    leave: () => {
      room.viewers.delete(viewer);
      const heldPrs = [...room.holders].filter(([, holder]) => holder.viewer === viewer).map(([prNumber]) => prNumber);
      for (const prNumber of heldPrs) release(prNumber);
      if (room.viewers.size === 0) rooms.delete(projectId);
    },
  };
}

export function prClaimHolder(projectId: string, prNumber: number): PrClaim | undefined {
  return rooms.get(projectId)?.holders.get(prNumber)?.claim;
}

export function announcePullsChanged(projectId: string): void {
  const room = rooms.get(projectId);
  if (room) broadcast(room, { type: "pulls-changed" });
}
