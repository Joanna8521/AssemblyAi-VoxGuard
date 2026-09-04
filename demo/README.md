# Demo spreadsheet

`daily-revenue-demo.csv` is thirty days of a small clothing shop, ending with a
slump the workforce is meant to notice: the last day is 47% below the average of
the twenty-nine before it, which is past the 20% threshold Daily Revenue treats
as worth waking somebody for.

It is deliberately not clean. Product names contain commas, money is written the
way a shop's own export writes it (`$3,126.80`), and some cells are empty. All
three break a naive reader, so a demo that runs on this is a demo that would run
on a real sheet.

## Putting it somewhere the agent can read

There is no OAuth here. A sheet shared as "anyone with the link can view" serves
CSV from an export endpoint, and that is the whole integration.

1. Open <https://sheets.new>
2. **File → Import → Upload**, choose `daily-revenue-demo.csv`, and pick
   *Replace spreadsheet*
3. **Share → General access → Anyone with the link → Viewer**, then **Copy link**
4. Paste that link into the app, or say it out loud

Say "check the revenue sheet" and Daily Revenue reads it, states the drop, and
asks the gate for permission to send the alert. Whether that alert goes anywhere
is the policy's decision, not the agent's.

## What the link means

Link sharing means anybody holding the link can read the sheet, this app
included. That is fine for a tab of daily totals and wrong for anything with
names, addresses or card details in it.
