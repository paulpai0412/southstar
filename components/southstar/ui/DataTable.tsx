export function DataTable(props: { columns: string[]; rows: Array<Record<string, React.ReactNode>> }) {
  return (
    <table className="ss-data-table">
      <thead><tr>{props.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{props.rows.map((row, index) => <tr key={index}>{props.columns.map((column) => <td key={column}>{row[column]}</td>)}</tr>)}</tbody>
    </table>
  );
}
