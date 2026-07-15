const fs = require('fs');
let src = fs.readFileSync('src/worker.js', 'utf8');

// The problematic pattern in source (inside template literal backtick):
// onclick="deleteSellerProduct(\\'' + p.id + '\\')"
// We need to find this exact sequence and replace with:
// onclick="deleteSellerProduct(&quot;' + p.id + '&quot;)"
// so the rendered HTML will use &quot; which browsers decode to " in onclick

// Find the exact string
const search = `deleteSellerProduct(\\\\'' + p.id + '\\\\')"`;
const found = src.indexOf(search);
console.log("Search pattern found at index:", found);

if (found === -1) {
  // Try alternative patterns
  console.log("Trying to find the line...");
  const lines = src.split('\n');
  for (let i = 4275; i < 4285; i++) {
    if (lines[i] && lines[i].includes('deleteSellerProduct')) {
      console.log(`Line ${i+1}:`, JSON.stringify(lines[i].substring(lines[i].indexOf('deleteSellerProduct'), lines[i].indexOf('deleteSellerProduct') + 60)));
    }
  }
}

// Direct byte replacement approach
const searchStr = "deleteSellerProduct(\\\\'";
const idx = src.indexOf(searchStr);
console.log("\nSearching for deleteSellerProduct(\\\\':", idx);

// Let's just find the line and do a targeted replace
const lines = src.split('\n');
const targetLine = 4279; // 0-indexed (line 4280)
const line = lines[targetLine];
console.log("\nOriginal line 4280 (first 80 chars from deleteSellerProduct):");
const dsIdx = line.indexOf('deleteSellerProduct');
if (dsIdx !== -1) {
  console.log(JSON.stringify(line.substring(dsIdx, dsIdx + 50)));
  
  // Replace \\' with &quot; around the p.id
  // Original: deleteSellerProduct(\\'' + p.id + '\\')"
  // Target:   deleteSellerProduct(&quot;' + p.id + '&quot;)"
  
  // Actually, let's use a simpler approach - just use " via \\x22
  // Or better: use &apos; 
  // Wait, the onclick uses \" delimiters, so we can use single quotes freely
  // But the JS string uses ' delimiters!
  
  // The issue is the double escaping. Let me think carefully:
  // 1. Source code (in template literal): onclick=\"deleteSellerProduct(\\'' + p.id + '\\')\">
  //    Here, \\' is 3 source chars: \, \, '
  //    After template literal processing: onclick="deleteSellerProduct(\'' + p.id + '\')"
  //    In the JS context (building innerHTML), \' inside ' string = escaped single quote = '
  //    So the JS runtime builds HTML: onclick="deleteSellerProduct('xxx')"
  //    This SHOULD work!
  
  // But the NEW Function test said it parses OK. Let me check what the BROWSER actually gets.
  // Maybe the issue is that Node doesn't render the template literal the same way?
  
  // Actually, the issue might be Cloudflare Worker runtime vs Node.js!
  // In Cloudflare, template literals MIGHT handle escapes differently.
  
  // SAFEST fix: avoid backslash escaping entirely
  // Use string concatenation with String.fromCharCode(39) for single quotes
  // Or better: use " quotes in onclick (since onclick uses \" delimiter from JS)
  
  const newLine = line.replace(
    `deleteSellerProduct(\\\\'' + p.id + '\\\\')"`,
    `deleteSellerProduct(" + p.id + ")"` 
  );
  
  if (newLine !== line) {
    console.log("Replace 1 worked!");
  } else {
    // Let me see the actual bytes
    console.log("\nActual bytes around deleteSellerProduct:");
    for (let c = dsIdx; c < dsIdx + 40 && c < line.length; c++) {
      console.log(`  [${c-dsIdx}] '${line[c]}' = ${line.charCodeAt(c)}`);
    }
  }
}
