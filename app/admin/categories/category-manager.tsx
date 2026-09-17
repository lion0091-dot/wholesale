"use client";

import { useState, useTransition } from "react";
import {
  addProductCategoryAction,
  addProductSubcategoryAction,
  deleteProductCategoryAction,
  deleteProductSubcategoryAction,
} from "./actions";

interface Subcategory {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
  subcategories: Subcategory[];
}

export function CategoryManager({ initialCategories }: { initialCategories: Category[] }) {
  const [categories, setCategories] = useState(initialCategories);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleAdd = () => {
    setError(null);
    startTransition(async () => {
      const result = await addProductCategoryAction(name);

      if (!result.success) {
        setError(result.error ?? "추가에 실패했습니다.");
        return;
      }

      setName("");
      window.location.reload();
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm("삭제하면 이 카테고리를 쓰던 상품은 값이 그대로 남지만 목록에서 사라집니다. 삭제할까요?")) {
      return;
    }

    startTransition(async () => {
      const result = await deleteProductCategoryAction(id);

      if (result.success) {
        setCategories((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError(result.error ?? "삭제에 실패했습니다.");
      }
    });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="새 카테고리명"
          style={{ flex: 1, padding: "8px 10px", fontSize: "13px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
        />
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={handleAdd}
          style={{
            fontSize: "13px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "8px 16px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          추가
        </button>
      </div>

      {error && <p style={{ fontSize: "12px", color: "#b91c1c", marginBottom: "12px" }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {categories.map((category) => (
          <CategoryRow
            key={category.id}
            category={category}
            onDeleteCategory={() => handleDelete(category.id)}
            onSubcategoriesChange={(subcategories) =>
              setCategories((prev) =>
                prev.map((c) => (c.id === category.id ? { ...c, subcategories } : c))
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  onDeleteCategory,
  onSubcategoriesChange,
}: {
  category: Category;
  onDeleteCategory: () => void;
  onSubcategoriesChange: (subcategories: Subcategory[]) => void;
}) {
  const [subName, setSubName] = useState("");
  const [subError, setSubError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleAddSub = () => {
    setSubError(null);
    startTransition(async () => {
      const result = await addProductSubcategoryAction(category.id, subName);

      if (!result.success) {
        setSubError(result.error ?? "추가에 실패했습니다.");
        return;
      }

      setSubName("");
      window.location.reload();
    });
  };

  const handleDeleteSub = (id: string) => {
    startTransition(async () => {
      const result = await deleteProductSubcategoryAction(id);

      if (result.success) {
        onSubcategoriesChange(category.subcategories.filter((s) => s.id !== id));
      } else {
        setSubError(result.error ?? "삭제에 실패했습니다.");
      }
    });
  };

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 700 }}>{category.name}</span>
        <button
          type="button"
          disabled={pending}
          onClick={onDeleteCategory}
          style={{
            fontSize: "11px",
            color: "#b91c1c",
            backgroundColor: "#ffffff",
            border: "1px solid #fca5a5",
            borderRadius: "6px",
            padding: "4px 10px",
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          카테고리 삭제
        </button>
      </div>

      <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {category.subcategories.map((sub) => (
          <span
            key={sub.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              backgroundColor: "#f1f5f9",
              color: "#334155",
              borderRadius: "5px",
              padding: "3px 4px 3px 8px",
            }}
          >
            {sub.name}
            <button
              type="button"
              disabled={pending}
              onClick={() => handleDeleteSub(sub.id)}
              title="부위 삭제"
              style={{
                border: "none",
                background: "none",
                color: "#94a3b8",
                cursor: pending ? "not-allowed" : "pointer",
                fontSize: "13px",
                lineHeight: 1,
                padding: "0 2px",
              }}
            >
              ×
            </button>
          </span>
        ))}
        {category.subcategories.length === 0 && (
          <span style={{ fontSize: "12px", color: "#94a3b8" }}>등록된 부위 없음</span>
        )}
      </div>

      <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
        <input
          type="text"
          value={subName}
          onChange={(e) => setSubName(e.target.value)}
          placeholder="새 부위명 (예: 등심)"
          style={{ flex: 1, padding: "6px 8px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "5px" }}
        />
        <button
          type="button"
          disabled={pending || !subName.trim()}
          onClick={handleAddSub}
          style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "#0f172a",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "5px",
            padding: "6px 10px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          부위 추가
        </button>
      </div>

      {subError && <p style={{ fontSize: "11px", color: "#b91c1c", marginTop: "6px" }}>{subError}</p>}
    </div>
  );
}
