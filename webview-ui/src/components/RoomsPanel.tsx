import { useEffect, useRef, useState } from 'react';

import type { RoomInfo } from '../hooks/useExtensionMessages.js';

interface RoomsPanelProps {
  rooms: RoomInfo[];
  /** Commit a new name for the room with this area label. */
  onRename: (label: string, name: string) => void;
}

/**
 * A compact top-left list of the office's rooms (standalone room-per-window).
 * Each row shows a room's name; clicking it turns the row into an input so the
 * user can rename the room in-app. Enter or blur commits; Escape cancels. Hidden
 * entirely when there are no rooms (every non-standalone mode).
 */
export function RoomsPanel({ rooms, onRename }: RoomsPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (rooms.length === 0) return null;

  const startEdit = (room: RoomInfo) => {
    setEditing(room.label);
    setDraft(room.name);
  };

  const commit = () => {
    if (editing) {
      const next = draft.trim();
      const current = rooms.find((r) => r.label === editing)?.name;
      if (next && next !== current) onRename(editing, next);
    }
    setEditing(null);
  };

  return (
    <div className="absolute top-8 left-8 z-40 flex flex-col gap-2 pixel-panel px-8 py-6 max-w-2xs">
      <span className="text-2xs opacity-60 leading-none mb-1">ROOMS</span>
      {rooms.map((room) => (
        <div key={room.label} className="leading-none">
          {editing === room.label ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') setEditing(null);
              }}
              className="w-full bg-transparent border-b border-border outline-none text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => startEdit(room)}
              title="Rename room"
              className="text-sm text-left w-full overflow-hidden text-ellipsis whitespace-nowrap hover:opacity-80"
            >
              {room.name}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
