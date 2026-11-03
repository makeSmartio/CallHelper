import React, { useState } from 'react';

interface NotesPanelProps {
  notes: string;
  onChange: (next: string) => void;
}

export const NotesPanel: React.FC<NotesPanelProps> = ({ notes, onChange }) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`panel shrink-0 ${collapsed ? '' : 'h-48'} flex flex-col`}>
      <div className="panel-header">
        <span className="panel-title">Notes</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {notes.length > 0 ? `${notes.length} chars · sent to AI` : 'visible to AI when filled'}
          </span>
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-xs text-gray-500 hover:text-red-400 transition-colors"
              title="Clear notes"
            >
              clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <textarea
            value={notes}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Jot anything — names, context, follow-ups. The AI sees this on every analysis tick."
            className="w-full h-full bg-transparent text-sm text-gray-200 placeholder-gray-600 px-3 py-2 resize-none focus:outline-none"
          />
        </div>
      )}
    </div>
  );
};
