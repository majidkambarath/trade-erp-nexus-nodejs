// ABC TRADE - who the company deals with and what it sells. Fictional names, plausible UAE places, prices anchored on the
// retail shelf prices found in the market check (Carrefour / Talabat) with a trade discount and a normal wholesale margin;
// where no price could be found (flour, tea) the figure is an estimate and is labelled as such in the summary.
const { uaeIban } = require("./abc-lib.cjs");

const BANKS = [
  { key: "enbd", bankName: "Emirates NBD", bankCode: "ENBD", swiftCode: "EBILAEAD", code3: "026" },
  { key: "mashreq", bankName: "Mashreq Bank", bankCode: "MASHREQ", swiftCode: "BOMLAEAD", code3: "033" },
  { key: "adcb", bankName: "Abu Dhabi Commercial Bank", bankCode: "ADCB", swiftCode: "ADCBAEAA", code3: "003" },
  { key: "rak", bankName: "RAKBANK", bankCode: "RAKBANK", swiftCode: "NRAKAEAK", code3: "035" },
];

const BANK_ACCOUNTS = [
  { key: "enbd", name: "Emirates NBD - Current Account (AED)", bank: "enbd", branchCode: "0261", number: "1015224409881201", holder: "ABC TRADE LLC" },
  { key: "mashreq", name: "Mashreq Bank - Current Account (AED)", bank: "mashreq", branchCode: "0331", number: "0192600114558801", holder: "ABC TRADE LLC" },
  { key: "rak", name: "RAKBANK - Business Collection Account", bank: "rak", branchCode: "0351", number: "0033118866207741", holder: "ABC TRADE LLC" },
].map((b) => ({ ...b, iban: uaeIban(BANKS.find((x) => x.key === b.bank).code3, b.number) }));

const EXTRA_ACCOUNTS = [
  ["Accumulated Depreciation - Furniture & Equipment", "Fixed Assets"],
  ["Accumulated Depreciation - Vehicles", "Fixed Assets"],
  ["Security Deposits", "Current Assets"],
  ["Prepaid Expenses", "Current Assets"],
  ["Staff Advances", "Current Assets"],
  ["Accrued Expenses", "Current Liabilities"],
  ["Owner's Drawings", "Equity"],
  ["Depreciation Expense", "Operating Expenses"],
  ["Insurance", "Operating Expenses"],
  ["Transport & Delivery", "Operating Expenses"],
  ["Fuel & Vehicle Running", "Operating Expenses"],
  ["Marketing & Advertising", "Operating Expenses"],
  ["Telephone & Internet", "Operating Expenses"],
  ["Repairs & Maintenance", "Operating Expenses"],
  ["Office Supplies", "Operating Expenses"],
  ["Government Fees & Licences", "Operating Expenses"],
  ["Professional Fees", "Operating Expenses"],
  ["Interest Expense", "Operating Expenses"],
];

const UNITS = [
  { key: "BAG", unitName: "Bag", shortCode: "BAG", type: "Base", category: "Packaging" },
  { key: "CTN", unitName: "Carton", shortCode: "CTN", type: "Base", category: "Packaging" },
  { key: "TIN", unitName: "Tin", shortCode: "TIN", type: "Base", category: "Packaging" },
  { key: "KG", unitName: "Kilogram", shortCode: "KG", type: "Base", category: "Weight" },
  { key: "PCS", unitName: "Piece", shortCode: "PCS", type: "Base", category: "Quantity" },
];

const CATEGORIES = ["Rice", "Sugar & Sweeteners", "Edible Oils & Ghee", "Flour & Grains", "Pulses & Lentils", "Tea & Beverages", "Spices & Seasoning", "Canned & Packaged Foods"];

const VENDORS = [
  { key: "gg", name: "Gulf Grain Importers LLC", contact: "Hamad Al Suwaidi", city: "Dubai, Deira - Naif", terms: "45 days", phone: "+971 4 223 6610", trn: "100234561200003" },
  { key: "sugar", name: "Emirates Sugar & Commodities FZE", contact: "Rakesh Menon", city: "Dubai, Jebel Ali Free Zone", terms: "30 days", phone: "+971 4 881 2204", trn: "100345672300003" },
  { key: "oils", name: "Al Safa Edible Oils Trading FZCO", contact: "Imran Qureshi", city: "Dubai, Silicon Oasis", terms: "30 days", phone: "+971 4 326 7745", trn: "100456783400003" },
  { key: "mill", name: "Desert Mill Flour Trading LLC", contact: "Yousef Al Marri", city: "Sharjah, Industrial Area 6", terms: "30 days", phone: "+971 6 534 9918", trn: "100567894500003" },
  { key: "spice", name: "Spice Route International LLC", contact: "Anita Varghese", city: "Dubai, Deira - Al Ras", terms: "45 days", phone: "+971 4 225 4417", trn: "100678905600003" },
  { key: "pack", name: "Horizon Packaged Foods Distribution LLC", contact: "Tariq Mahmood", city: "Dubai, Al Quoz Industrial 4", terms: "60 days", phone: "+971 4 339 1180", trn: "100789016700003" },
  { key: "log", name: "Falcon Logistics & Warehousing LLC", contact: "Saeed Al Ketbi", city: "Dubai, Ras Al Khor", terms: "30 days", phone: "+971 4 289 6052", trn: "100890127800003" },
];

// type drives what a customer buys (see `affinity` on each item) and how much; w is how often they order
const CUSTOMERS = [
  { key: "madina", name: "Al Madina Fresh Supermarket LLC", type: "supermarket", contact: "Khalid Al Nuaimi", addr: "Al Quoz Industrial Area 3, Dubai", terms: "Net 30", credit: 150000, w: 5, trn: "100121234500003", phone: "+971 4 347 2210" },
  { key: "basket", name: "Green Basket Hypermarket LLC", type: "supermarket", contact: "Mohammed Rafiq", addr: "Industrial Area 12, Sharjah", terms: "Net 45", credit: 200000, w: 4, trn: "100232345600003", phone: "+971 6 531 8870" },
  { key: "coral", name: "Coral Bay Grocery & Mini Market", type: "supermarket", contact: "Suresh Pillai", addr: "Al Jurf Industrial 2, Ajman", terms: "Net 30", credit: 60000, w: 2, trn: "100343456700003", phone: "+971 6 743 1164" },
  { key: "garden", name: "Spice Garden Restaurant LLC", type: "restaurant", contact: "Chef Anil Kumar", addr: "Karama, Dubai", terms: "Net 30", credit: 40000, w: 3, trn: "100454567800003", phone: "+971 4 337 5521" },
  { key: "feast", name: "Royal Feast Catering Services LLC", type: "caterer", contact: "Nadia Haddad", addr: "Al Qusais Industrial 1, Dubai", terms: "Net 45", credit: 90000, w: 4, trn: "100565678900003", phone: "+971 4 258 7733" },
  { key: "seven", name: "Seven Seas Cafeteria", type: "restaurant", contact: "Joseph D'Souza", addr: "Mussafah M-37, Abu Dhabi", terms: "Net 30", credit: 30000, w: 2, trn: "100676789000003", phone: "+971 2 554 0912" },
  { key: "pearl", name: "Desert Pearl Staff Accommodation Catering", type: "caterer", contact: "Obaid Al Mazrouei", addr: "ICAD 1, Abu Dhabi", terms: "Net 60", credit: 120000, w: 3, trn: "100787890100003", phone: "+971 2 551 6648" },
  { key: "reef", name: "Al Reef Trading Co. LLC", type: "wholesale", contact: "Faisal Sharif", addr: "Deira - Naif, Dubai", terms: "Net 30", credit: 120000, w: 4, trn: "100898901200003", phone: "+971 4 271 3395" },
  { key: "star", name: "Bright Star Wholesale LLC", type: "wholesale", contact: "Manoj Thakkar", addr: "Muwaileh Commercial, Sharjah", terms: "Net 45", credit: 150000, w: 3, trn: "100909012300003", phone: "+971 6 565 2287" },
  { key: "sohar", name: "Sohar Valley Trading LLC", type: "export", contact: "Salim Al Harthy", addr: "Sohar Industrial Port, Oman", terms: "Net 30", credit: 250000, w: 2, trn: null, phone: "+968 2685 4410", country: "OM" },
  { key: "palm", name: "Palm Grove Hotel Apartments", type: "hotel", contact: "Elena Petrova", addr: "Dubai Marina, Dubai", terms: "Net 45", credit: 70000, w: 2, trn: "100010123400003", phone: "+971 4 368 9004" },
  { key: "cash", name: "Walk-in Cash Customer", type: "cash", contact: "Counter Sales", addr: "Ras Al Khor Showroom, Dubai", terms: "Cash on Delivery", credit: 10000, w: 2, trn: null, phone: "+971 50 000 0000" },
];

// cost / price in AED per unit; demand = units a month in an ordinary month; open = go-live stock; aff = who buys it
const ITEMS = [
  { sku: "RIC-BAS-40", name: "Basmati Rice 1121 Sella XXL - 40kg Bag", cat: "Rice", unit: "BAG", brand: "Royal Gold", origin: "India", vendor: "gg", cost: 205, price: 232, reorder: 40, demand: 70, open: [180, 204], aff: ["supermarket", "wholesale", "caterer", "export", "hotel"] },
  { sku: "RIC-BAS-05", name: "Basmati Rice Premium - 5kg Pack", cat: "Rice", unit: "PCS", brand: "Sunrise", origin: "India", vendor: "gg", cost: 25.5, price: 29.5, reorder: 150, demand: 260, open: [600, 25.2], aff: ["supermarket", "cash", "restaurant"] },
  { sku: "RIC-SEL-20", name: "Parboiled Sella Rice - 20kg Bag", cat: "Rice", unit: "BAG", brand: "Nile Pearl", origin: "India", vendor: "gg", cost: 68, price: 78, reorder: 40, demand: 80, open: [220, 67.5], aff: ["caterer", "restaurant", "wholesale", "hotel"] },
  { sku: "RIC-WHT-25", name: "White Long Grain Rice - 25kg Bag", cat: "Rice", unit: "BAG", brand: "Golden Harvest", origin: "Pakistan", vendor: "gg", cost: 70, price: 80, reorder: 30, demand: 55, open: [160, 69], aff: ["caterer", "wholesale", "export"] },
  { sku: "SUG-WHT-50", name: "White Refined Sugar - 50kg Bag", cat: "Sugar & Sweeteners", unit: "BAG", brand: "Crystal Mark", origin: "UAE", vendor: "sugar", cost: 150, price: 168, reorder: 60, demand: 110, open: [300, 148], aff: ["wholesale", "caterer", "supermarket", "export", "hotel"] },
  { sku: "SUG-WHT-10", name: "White Refined Sugar - 10kg Pack", cat: "Sugar & Sweeteners", unit: "PCS", brand: "Crystal Mark", origin: "UAE", vendor: "sugar", cost: 33, price: 38, reorder: 80, demand: 150, open: [250, 32.5], aff: ["supermarket", "cash", "restaurant"] },
  { sku: "OIL-SUN-18", name: "Sunflower Oil - 18L Tin", cat: "Edible Oils & Ghee", unit: "TIN", brand: "SunGold", origin: "Ukraine", vendor: "oils", cost: 148, price: 165, reorder: 40, demand: 75, open: [140, 146], aff: ["caterer", "restaurant", "wholesale", "hotel", "export"] },
  { sku: "OIL-SUN-15", name: "Sunflower Oil - 1.5L x 6 Carton", cat: "Edible Oils & Ghee", unit: "CTN", brand: "SunGold", origin: "Ukraine", vendor: "oils", cost: 60, price: 68, reorder: 50, demand: 95, open: [200, 59.5], aff: ["supermarket", "cash", "wholesale"] },
  { sku: "OIL-GHE-16", name: "Pure Ghee - 1.6kg x 6 Carton", cat: "Edible Oils & Ghee", unit: "CTN", brand: "Golden Cow", origin: "India", vendor: "oils", cost: 190, price: 212, reorder: 15, demand: 25, open: [60, 188], aff: ["supermarket", "restaurant", "caterer"] },
  { sku: "OIL-CRN-09", name: "Corn Oil - 9L Bottle", cat: "Edible Oils & Ghee", unit: "PCS", brand: "Corn Dew", origin: "Turkey", vendor: "oils", cost: 118, price: 132, reorder: 20, demand: 35, open: [80, 117], aff: ["supermarket", "restaurant", "hotel"] },
  { sku: "FLR-APF-50", name: "All-Purpose Wheat Flour - 50kg Bag", cat: "Flour & Grains", unit: "BAG", brand: "Desert Mill", origin: "UAE", vendor: "mill", cost: 98, price: 112, reorder: 50, demand: 90, open: [220, 97], aff: ["caterer", "restaurant", "wholesale", "hotel"] },
  { sku: "FLR-ATA-10", name: "Whole Wheat Atta - 10kg Pack", cat: "Flour & Grains", unit: "PCS", brand: "Desert Mill", origin: "UAE", vendor: "mill", cost: 21, price: 24.5, reorder: 60, demand: 110, open: [150, 20.8], aff: ["supermarket", "cash", "wholesale"] },
  { sku: "PUL-CHK-25", name: "Chickpeas Kabuli - 25kg Bag", cat: "Pulses & Lentils", unit: "BAG", brand: "Anatolia", origin: "Turkey", vendor: "gg", cost: 110, price: 124, reorder: 20, demand: 38, open: [100, 108], aff: ["caterer", "restaurant", "wholesale", "export"] },
  { sku: "PUL-MAS-25", name: "Red Lentils Masoor - 25kg Bag", cat: "Pulses & Lentils", unit: "BAG", brand: "Anatolia", origin: "Canada", vendor: "gg", cost: 130, price: 146, reorder: 20, demand: 32, open: [80, 128], aff: ["caterer", "restaurant", "wholesale"] },
  { sku: "PUL-TUR-25", name: "Toor Dal - 25kg Bag", cat: "Pulses & Lentils", unit: "BAG", brand: "Anatolia", origin: "India", vendor: "gg", cost: 165, price: 184, reorder: 15, demand: 24, open: [60, 163], aff: ["caterer", "restaurant", "wholesale"] },
  { sku: "TEA-CTC-20", name: "Black Tea CTC - 400g x 20 Carton", cat: "Tea & Beverages", unit: "CTN", brand: "Chai Royale", origin: "Kenya", vendor: "spice", cost: 168, price: 190, reorder: 20, demand: 34, open: [90, 166], aff: ["supermarket", "restaurant", "caterer", "cash", "hotel"] },
  { sku: "CAN-CHK-24", name: "Canned Chickpeas 400g x 24 Carton", cat: "Canned & Packaged Foods", unit: "CTN", brand: "Horizon", origin: "Turkey", vendor: "pack", cost: 52, price: 62, reorder: 20, demand: 30, open: [70, 51], aff: ["supermarket", "restaurant", "cash"] },
  { sku: "CAN-TOM-12", name: "Tomato Paste 800g x 12 Carton", cat: "Canned & Packaged Foods", unit: "CTN", brand: "Horizon", origin: "Italy", vendor: "pack", cost: 44, price: 52, reorder: 25, demand: 42, open: [90, 43], aff: ["supermarket", "restaurant", "caterer", "hotel"] },
];

// carried forward from the previous system on go-live day (reference = the old invoice number)
const OPENING_CUSTOMERS = [
  ["madina", "INV-2024-1187", 38450.0, 12], ["madina", "INV-2024-1203", 21780.5, 24], ["feast", "INV-2024-1190", 15220.0, 18],
  ["basket", "INV-2024-1176", 42615.75, 9], ["garden", "INV-2024-1211", 9860.0, 27], ["reef", "INV-2024-1198", 27340.25, 15],
];
const OPENING_VENDORS = [
  ["gg", "GGI/24/0918", 48300.0, 20], ["oils", "ASE-24-5530", 31450.5, 14], ["mill", "DM-24-2071", 19880.0, 26],
  ["sugar", "ESC/1124/77", 36200.0, 8], ["log", "FLW-24-0412", 4860.0, 30],
];

module.exports = { BANKS, BANK_ACCOUNTS, EXTRA_ACCOUNTS, UNITS, CATEGORIES, VENDORS, CUSTOMERS, ITEMS, OPENING_CUSTOMERS, OPENING_VENDORS };
