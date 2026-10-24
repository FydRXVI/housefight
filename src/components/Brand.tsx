interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="House Fight">
      <span className="brand__house">HOUSE</span>
      <span className="brand__slash" aria-hidden="true">/</span>
      <span className="brand__fight">FIGHT</span>
    </div>
  );
}
