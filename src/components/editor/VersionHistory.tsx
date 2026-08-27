"use client";

import { useState } from "react";

interface Version {
  id: string;
  source: string;
  prompt: string | null;
  created_at: string;
  parent_version_id: string | null;
}

interface VersionHistoryProps {
  versions: Version[];
  currentVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  onMakeCurrent: (versionId: string) => void;
}

export default function VersionHistory({
  versions,
  currentVersionId,
  onSelectVersion,
  onMakeCurrent,
}: VersionHistoryProps) {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  // Build tree structure
  const buildTree = (parentId: string | null): Version[] => {
    return versions
      .filter((v) => v.parent_version_id === parentId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  };

  const renderVersion = (version: Version, depth: number = 0) => {
    const children = buildTree(version.id);
    const isSelected = selectedVersion === version.id;
    const isCurrent = version.id === currentVersionId;

    return (
      <div key={version.id} style={{ marginLeft: depth * 20 }}>
        <div
          className={`p-3 border rounded-lg mb-2 cursor-pointer ${
            isSelected ? "border-blue-500 bg-blue-50" : "border-gray-200"
          } ${isCurrent ? "ring-2 ring-green-500" : ""}`}
          onClick={() => {
            setSelectedVersion(version.id);
            onSelectVersion(version.id);
          }}
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="font-medium">{version.source}</p>
              <p className="text-sm text-gray-500">
                {new Date(version.created_at).toLocaleString()}
              </p>
              {version.prompt && (
                <p className="text-sm mt-1 text-gray-600">{version.prompt}</p>
              )}
            </div>
            <div className="flex gap-2">
              {isCurrent && (
                <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                  Current
                </span>
              )}
              {!isCurrent && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMakeCurrent(version.id);
                  }}
                  className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded"
                >
                  Make Current
                </button>
              )}
            </div>
          </div>
        </div>
        
        {children.length > 0 && (
          <div className="border-l-2 border-gray-200 ml-2">
            {children.map((child) => renderVersion(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootVersions = buildTree(null);

  return (
    <div className="border rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">Version History</h3>
      
      {rootVersions.length === 0 ? (
        <p className="text-gray-500">No versions yet</p>
      ) : (
        <div className="space-y-2">
          {rootVersions.map((version) => renderVersion(version))}
        </div>
      )}
    </div>
  );
}
