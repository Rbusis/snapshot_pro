import csv
import os

file_path = "/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv"

# Read the data back properly
rows = []
with open(file_path, 'r', encoding='utf-8') as f:
    reader = csv.reader(f, delimiter=';')
    rows = list(reader)

header = rows[0][:17]
new_rows = []

for i, row in enumerate(rows[1:]):
    row_idx = i + 2
    # Base data (columns 0 to 14)
    data = row[:15]
    while len(data) < 15:
        data.append('')
    
    # We use SUMIF with , as separator
    # IMPORTANT: To avoid Numbers treating it as text, we write it WITHOUT double quotes inside the formula if possible
    # and we will write the CSV manually to ensure no outer quotes.
    total_long_formula = f'=SUMIF($G$2:G{row_idx},"LONG",$J$2:J{row_idx})'
    total_short_formula = f'=SUMIF($G$2:G{row_idx},"SHORT",$J$2:J{row_idx})'
    
    data.append(total_long_formula)
    data.append(total_short_formula)
    new_rows.append(data)

# Manual write to avoid automatic quoting of formulas
with open(file_path, 'w', encoding='utf-8') as f:
    # Join header
    f.write(';'.join(header) + '\n')
    for row in new_rows:
        # For each cell, we only quote if it contains a semicolon
        processed_row = []
        for cell in row:
            if ';' in cell:
                # Escape quotes and wrap in quotes
                escaped = cell.replace('"', '""')
                processed_row.append(f'"{escaped}"')
            else:
                processed_row.append(cell)
        f.write(';'.join(processed_row) + '\n')

print(f"Applied unquoted formulas to {len(new_rows)} rows.")
