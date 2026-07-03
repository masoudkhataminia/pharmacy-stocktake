# Pharmacy Stocktake Scanner

A Next.js prototype for pharmacy stocktake workflows.

## What it does

- Imports pharmacy export files in CSV, TSV, or TXT format.
- Auto-detects common columns such as label/Rx number, patient name, prescription date, medicine, and quantity.
- Supports manual label entry and browser camera barcode scanning where `BarcodeDetector` is available.
- Shows the matched patient, date, medicine, and quantity before saving.
- Requires the user to press **Confirm** before a scan is saved.
- Warns when the same label is scanned again.
- Stores the current session in browser local storage.

## Current status

This branch replaces the default Create Next App screen with a working stocktake prototype suitable for early pharmacy demo/testing.

## Run locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Testing checklist

1. Click **Load demo**.
2. Enter `RX10021` and press **Confirm**.
3. Confirm that the app shows the patient, date, medicine, and quantity.
4. Enter the same label again and confirm duplicate warning appears.
5. Enter a missing label such as `RX99999` and confirm it is saved as unmatched.
6. Upload a real pharmacy CSV export and check that column detection works.
7. On a mobile browser that supports BarcodeDetector, test **Start camera** and scan a label without taking a photo.

## Notes

- Native `.xlsx` parsing is not included yet. Export Excel files as CSV first.
- Camera barcode scanning depends on browser support for the Web Barcode Detection API.
- No patient data leaves the browser in this prototype.
