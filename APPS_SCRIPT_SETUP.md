# Google Apps Script Setup (One-Time)

## Sheet ko Update karne ke liye ye steps follow karo:

### Step 1: Google Sheet kholo
- Apni Google Sheet kholo jisko monitor kar rahe ho

### Step 2: Apps Script kholo
- Menu: **Extensions > Apps Script**

### Step 3: Code paste karo
- Jo code niche hai wo poora copy karo aur Apps Script editor mein paste karo (purana code delete karo):

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    var spreadsheet = SpreadsheetApp.openById(data.sheetId);
    var sheet = spreadsheet.getSheetByName(data.tabName);
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({error: 'Tab not found'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Update Status column
    sheet.getRange(data.row, data.statusCol).setValue(data.statusValue);
    
    // Update Date column
    sheet.getRange(data.row, data.dateCol).setValue(data.dateValue);
    
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

### Step 4: Deploy karo
1. **Deploy** button click karo (top right) > **New deployment**
2. Type: **Web app**
3. Execute as: **Me**
4. Who has access: **Anyone**
5. **Deploy** click karo
6. **URL copy karo** — ye URL dashboard mein "Apps Script URL" field mein paste karo

### Done!
Ab jab bhi message bhejega, sheet automatically "Sent" aur date se update ho jayegi.

### Note:
- Ye ek baar karna hai, phir sab automatic chalega
- URL ek baar save hone ke baad bar bar dalne ki zaroorat nahi
