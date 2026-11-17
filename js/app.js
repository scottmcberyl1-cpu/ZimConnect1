const pages={};

function toast(msg){
  const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>t.classList.remove("show"),2600);
}
function showPage(page){
  if(!pages[page]) page="home";
  document.getElementById("app").innerHTML=pages[page]();
  document.querySelectorAll(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.page===page));
  window.scrollTo({top:0,behavior:"smooth"});
}
function searchFromHeader(e){if(e.key==="Enter"){const q=e.target.value.trim(); if(q){showPage("explore"); setTimeout(()=>{const s=document.getElementById("pageSearch");if(s){s.value=q;filterProducts()}},50)}}}
function filterProducts(){
  const q=(document.getElementById("pageSearch")?.value||"").toLowerCase();
  document.querySelectorAll(".searchable").forEach(c=>c.style.display=c.innerText.toLowerCase().includes(q)?"":"none");
}
function addCart(name){toast(name+" added to your cart ✓")}
function fakeAction(msg){toast(msg+" ✓")}

pages.home=()=>`
<section class="hero">
  <div class="pill">🇿🇼 Zimbabwe's Digital Business Ecosystem</div>
  <h1>Connect. Trade. Deliver. Learn. Grow.</h1>
  <p>Discover verified businesses, shop locally, source wholesale products, find opportunities, learn business skills and access delivery—all in one place.</p>
  <div class="hero-search">🔎 Search products, businesses, suppliers or services…</div>
</section>
${locationImage()}
<div class="section-head"><h2>Everything you need in one place</h2><span class="muted">Harare, Zimbabwe ▾</span></div>
<div class="categories">
 ${cat("🛒","Shop & Buy","explore")}${cat("🏪","Businesses","explore")}${cat("📦","Suppliers","suppliers")}${cat("🚚","Deliveries","delivery")}${cat("🎓","Academy","academy")}${cat("💼","Opportunities","opportunities")}${cat("📢","Advertise","advertise")}${cat("🆘","Support","support")}
</div>
<div class="section-head"><h2>Featured businesses</h2><div class="actions"><button class="btn secondary" onclick="showPage('explore')">View all</button><button class="btn" onclick="showPage('register')">🏪 Register a Business</button></div></div>
<div class="grid">
 ${business("🛒","FreshMart Supermarket","Groceries","4.8","1.2 km")}
 ${business("📱","Tech Zone","Electronics","4.7","2.8 km")}
 ${business("👗","Zim Fashion Hub","Fashion","4.6","3.5 km")}
</div>
<div class="section-head"><h2>Popular products</h2><span class="muted">Trusted local sellers</span></div>
<div class="product-grid">
 ${product("🎧","Wireless Headphones","$45.00","Tech Zone")}
 ${product("👟","School Shoes","$25.00","ABC Shoes")}
 ${product("🧺","Groceries Basket","$32.50","FreshMart")}
 ${product("👕","Local Cotton T-Shirt","$18.00","Zim Fashion Hub")}
</div>
`;

function locationImage(){return `<img class="image-banner" src="assets/zimconnect-concept.png" alt="ZimConnect concept preview">`}
function cat(icon,name,page){return `<button class="cat" onclick="showPage('${page}')"><div class="cat-icon">${icon}</div><b>${name}</b></button>`}
function business(icon,name,catg,rating,dist){return `<div class="card business-card"><div class="avatar">${icon}</div><div style="flex:1"><h3>${name} <span class="pill">✓ Verified</span></h3><div class="muted">${catg} · ${dist}</div><div class="rating">★ ${rating}</div></div><button class="btn secondary" onclick="toast('Opening ${name}')">Open</button></div>`}
function product(icon,name,price,shop){return `<div class="card product-card"><div class="product-img">${icon}</div><div class="content"><h3>${name}</h3><div class="muted">${shop} · <span class="rating">★ 4.7</span></div><p class="price">${price}</p><span class="pill">In stock</span><div class="actions"><button class="btn" onclick="addCart('${name}')">Add to cart</button><button class="btn secondary" onclick="toast('Viewing ${name}')">View</button></div></div></div>`}

pages.explore=()=>`
<div class="section-head"><div><h2>Explore Zimbabwe</h2><p class="muted">Find verified businesses, products and services near you.</p></div></div>
<div class="card"><div class="global-search" style="max-width:none;background:#f8faf9"><span>⌕</span><input id="pageSearch" placeholder="Search e.g. school shoes, restaurants, electronics..." oninput="filterProducts()"></div></div>
<div class="section-head"><h2>Products & businesses</h2><span class="pill">Verified sellers first</span></div>
<div class="product-grid">
 ${product("🎧","Wireless Headphones","$45.00","Tech Zone").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("👟","School Shoes","$25.00","ABC Shoes").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("📱","Smartphone","$220.00","Mobile World").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("🪑","Office Chair","$85.00","Home Essentials").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("🍞","Family Grocery Pack","$32.50","FreshMart").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("👗","African Print Dress","$38.00","Zim Fashion Hub").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("🌱","Vegetable Seed Pack","$8.50","AgroLink").replace('class="card product-card"','class="card product-card searchable"')}
 ${product("🔌","Solar Home Kit","$120.00","PowerHub Zimbabwe").replace('class="card product-card"','class="card product-card searchable"')}
</div>`;

pages.suppliers=()=>`
<div class="hero"><div class="pill">🏭 B2B Marketplace</div><h1>Source wholesale products.</h1><p>Connect businesses with verified suppliers, bulk pricing, minimum order quantities and delivery options.</p><button class="btn" onclick="fakeAction('Supplier search opened')">Find a Supplier</button></div>
<div class="section-head"><h2>Wholesale categories</h2></div>
<div class="categories" style="grid-template-columns:repeat(6,1fr)">${cat("🍚","Food","suppliers")}${cat("👕","Textiles","suppliers")}${cat("📱","Electronics","suppliers")}${cat("🏗️","Construction","suppliers")}${cat("🌾","Agriculture","suppliers")}${cat("💄","Beauty","suppliers")}</div>
<div class="section-head"><h2>Featured suppliers</h2></div>
<div class="grid">
 ${supplier("Harare Wholesale Foods","🍚","Food & Beverages","Bulk prices from $32","Harare")}
 ${supplier("ZimTextiles Ltd","👕","Clothing & Textiles","Bulk prices from $12","Bulawayo")}
 ${supplier("TechSupplies ZW","💻","Electronics","Bulk prices from $50","Harare")}
</div>
<div class="section-head"><h2>Bulk pricing example</h2></div>
<div class="card table-wrap"><table class="table"><tr><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Action</th></tr><tr><td>1–9</td><td>$10</td><td>—</td><td><button class="btn secondary">Request quote</button></td></tr><tr><td>10–49</td><td>$9</td><td>10%</td><td><button class="btn secondary">Request quote</button></td></tr><tr><td>50–99</td><td>$8</td><td>20%</td><td><button class="btn secondary">Request quote</button></td></tr><tr><td>100+</td><td>$7</td><td>30%</td><td><button class="btn">Bulk order</button></td></tr></table></div>`;
function supplier(name,icon,catg,price,loc){return `<div class="card"><div class="business-card"><div class="avatar">${icon}</div><div><h3>${name} <span class="pill">✓ Verified</span></h3><div class="muted">${catg} · ${loc}</div></div></div><p>${price}</p><div class="actions"><button class="btn" onclick="toast('Opening supplier catalogue')">View catalogue</button><button class="btn secondary" onclick="toast('Quote request started')">Request quote</button></div></div>`}

pages.orders=()=>`
<div class="section-head"><div><h2>My Orders</h2><p class="muted">Track purchases and deliveries.</p></div><span class="pill">3 active</span></div>
<div class="card" style="margin-bottom:14px"><div class="business-card"><div class="avatar">🎧</div><div style="flex:1"><h3>Order #ZC4587 <span class="pill">Out for delivery</span></h3><div class="muted">Tech Zone · 2 items · $69.99</div></div><button class="btn" onclick="showPage('delivery')">Track</button></div><div class="timeline"><div class="done"><div class="dot">✓</div>Confirmed</div><div class="done"><div class="dot">✓</div>Prepared</div><div class="done"><div class="dot">✓</div>Picked up</div><div class="done"><div class="dot">🚚</div>On the way</div><div><div class="dot">✓</div>Delivered</div></div></div>
<div class="card"><div class="business-card"><div class="avatar">👟</div><div style="flex:1"><h3>Order #ZC4586 <span class="pill">Delivered</span></h3><div class="muted">ABC Shoes · $50.00 · Yesterday</div></div><button class="btn secondary" onclick="toast('Receipt opened')">Receipt</button></div></div>`;

pages.delivery=()=>`
<div class="section-head"><div><h2>Delivery Tracking</h2><p class="muted">Order #ZC4587 · Live status</p></div><span class="pill">On the way</span></div>
<div class="split"><div class="card"><div class="map"><div class="pin one">📍</div><div class="pin two">🏠</div><div class="pin three">🛵</div></div><div class="section-head"><h2>Tawanda Moyo</h2><span class="rating">★ 4.8</span></div><p class="muted">Verified delivery agent · Motorcycle</p><div class="actions"><button class="btn" onclick="toast('Calling Tawanda...')">📞 Call</button><button class="btn secondary" onclick="toast('Chat opened')">💬 Chat</button></div></div>
<div class="card"><h3>Estimated arrival</h3><div style="font-size:30px;font-weight:850;margin:12px 0">12:25 PM</div><p class="muted">Arriving in approximately 13 minutes.</p><ul class="checklist"><li>Business confirmed order</li><li>Agent collected order</li><li>Driver is on the way</li><li>Customer confirmation at delivery</li></ul></div></div>`;

pages.academy=()=>`
<div class="hero"><div class="pill">🎓 ZimConnect Academy</div><h1>Learn. Build. Grow.</h1><p>Practical lessons that help entrepreneurs start, operate, market and grow their businesses.</p></div>
<div class="section-head"><h2>Learning categories</h2></div>
<div class="categories" style="grid-template-columns:repeat(6,1fr)">${cat("🚀","Start a Business","academy")}${cat("💰","Finance","academy")}${cat("📢","Marketing","academy")}${cat("🛒","Sales","academy")}${cat("💻","Digital","academy")}${cat("👥","Leadership","academy")}</div>
<div class="section-head"><h2>Recommended courses</h2></div>
<div class="grid">
 ${course("🚀","How to Start a Small Business","Beginner · 35 min")}
 ${course("💰","Financial Management & Cash Flow","Beginner · 42 min")}
 ${course("📱","Digital Marketing for SMEs","Intermediate · 1 hr")}
 ${course("🤝","Customer Service Excellence","Beginner · 25 min")}
</div>
<div class="section-head"><h2>My progress</h2></div><div class="card"><b>Business Basics</b><div class="progress" style="margin-top:10px"><span style="width:72%"></span></div><p class="muted">72% complete · 3 lessons remaining</p><button class="btn" onclick="fakeAction('Lesson started')">Continue learning</button></div>`;
function course(icon,title,meta){return `<div class="card course"><div class="course-icon">${icon}</div><div><h3>${title}</h3><div class="muted">${meta}</div><p>Video lessons, practical examples, exercises and a completion certificate.</p><button class="btn" onclick="toast('Course opened')">Start Learning</button></div></div>`}

pages.opportunities=()=>`
<div class="hero"><div class="pill">💼 Opportunity Hub</div><h1>Find your next business opportunity.</h1><p>Explore business models with estimated startup costs, requirements, operating expenses, risks and projected financial outcomes.</p></div>
<div class="section-head"><h2>Find opportunities</h2><span class="muted">Zimbabwe-wide</span></div>
<div class="card"><div class="form-grid"><div class="field"><label>Available capital</label><input placeholder="$1,000" id="capital"></div><div class="field"><label>Location</label><select><option>All Zimbabwe</option><option>Harare</option><option>Bulawayo</option><option>Manicaland</option><option>Masvingo</option><option>Matabeleland South</option><option>Midlands</option></select></div></div><div class="actions"><button class="btn" onclick="fakeAction('Opportunity recommendations generated')">Find businesses I can afford</button></div></div>
<div class="section-head"><h2>Featured opportunities</h2></div>
<div class="grid">${opportunity("🐔","Broiler Farming","$450","$1,200","Medium","Agriculture")}${opportunity("🍅","Vegetable Production","$350","$900","Medium","Agriculture")}${opportunity("🧁","Home Baking Business","$300","$800","Low","Food")}</div>`;
function opportunity(icon,title,capital,total,risk,catg){return `<div class="card opportunity"><div class="op-top"><h3>${icon} ${title}</h3><span class="pill">${risk} Risk</span></div><p class="muted">${catg} · Zimbabwe</p><div class="cost">Startup: ${capital}</div><p><b>Estimated total capital:</b> ${total}</p><ul class="checklist"><li>Basic equipment</li><li>Working capital</li><li>Market access</li><li>Relevant skills/requirements</li></ul><div class="actions"><button class="btn" onclick="toast('Opportunity details opened')">View details</button><button class="btn secondary" onclick="showPage('academy')">Learn</button></div></div>`}

pages.advertise=()=>`
<div class="section-head"><div><h2>ZimConnect Ads</h2><p class="muted">Create in-app campaigns and share your business beyond ZimConnect.</p></div><span class="pill">Business growth</span></div>
<div class="split"><div class="card"><h3>Create advertisement</h3><div class="form-grid">
<div class="field full"><label>Advertisement title</label><input placeholder="20% OFF School Shoes!"></div>
<div class="field"><label>Media</label><select><option>Image</option><option>Short video</option></select></div>
<div class="field"><label>Target location</label><select><option>All Zimbabwe</option><option>Harare</option><option>Bulawayo</option><option>Mutare</option></select></div>
<div class="field full"><label>Description</label><textarea placeholder="Tell customers about your offer..."></textarea></div>
<div class="field"><label>Daily budget</label><input placeholder="$5"></div><div class="field"><label>Campaign duration</label><input placeholder="7 days"></div>
</div><div class="actions"><button class="btn" onclick="fakeAction('Advertisement submitted for review')">Submit Ad</button><button class="btn secondary" onclick="toast('Media picker opened')">Upload media</button></div></div>
<div class="card"><h3>Ad preview</h3><div class="ad-preview"><b>🔥 SPECIAL OFFER</b><strong style="font-size:26px">20% OFF SCHOOL SHOES</strong><span>ABC Shoes · Harare · ✓ Verified</span><button class="btn warning" style="width:max-content;margin-top:10px">SHOP NOW</button></div></div></div>
<div class="section-head"><h2>Advertise outside the app</h2></div>
<div class="card"><div class="business-card"><div class="avatar">🔗</div><div style="flex:1"><h3>Shareable business link</h3><p class="muted">zimconnect.co.zw/business/abc-electronics</p></div><button class="btn" onclick="fakeAction('Link copied')">Copy link</button></div><hr style="border:0;border-top:1px solid #e8eeeb;margin:18px 0"><div class="actions"><button class="btn secondary" onclick="fakeAction('WhatsApp share opened')">WhatsApp</button><button class="btn secondary" onclick="fakeAction('Social share opened')">Facebook</button><button class="btn secondary" onclick="fakeAction('QR code generated')">Generate QR</button><button class="btn secondary" onclick="fakeAction('Download poster created')">Create poster</button></div></div>`;

pages.business=()=>`
<div class="section-head"><div><h2>Business Dashboard</h2><p class="muted">ABC Electronics <span class="pill">✓ Verified Business</span></p></div><button class="btn" onclick="showPage('advertise')">📢 Promote business</button></div>
<div class="stat-grid"><div class="stat"><small>Today's sales</small><strong>$185</strong><span class="muted">↑ 12%</span></div><div class="stat"><small>Orders</small><strong>27</strong><span class="muted">8 pending</span></div><div class="stat"><small>Customers</small><strong>21</strong><span class="muted">5 new</span></div><div class="stat"><small>Rating</small><strong>4.8 ★</strong><span class="muted">126 reviews</span></div></div>
<div class="section-head"><h2>Quick actions</h2></div><div class="grid">${quick("➕","Add Products","Upload products and manage stock.")}${quick("📦","Manage Orders","Review, accept and fulfil orders.")}${quick("📊","View Analytics","Sales, customers and product trends.")}</div>
<div class="section-head"><h2>Sales performance</h2></div><div class="card"><div class="mini-chart">${[1,2,3,4,5,6,7].map(i=>`<div class="bar"></div>`).join("")}</div><div class="muted">Last 7 days</div></div>`;
function quick(icon,title,desc){return `<div class="card"><div class="avatar">${icon}</div><h3 style="margin-top:12px">${title}</h3><p class="muted">${desc}</p><button class="btn secondary" onclick="toast('${title} opened')">Open</button></div>`}

pages.supplierDash=()=>`
<div class="section-head"><div><h2>Supplier Dashboard</h2><p class="muted">Zim Wholesale · <span class="pill">✓ Verified Supplier</span></p></div><button class="btn" onclick="toast('Product form opened')">Add wholesale product</button></div>
<div class="stat-grid"><div class="stat"><small>Total products</small><strong>154</strong></div><div class="stat"><small>Bulk orders</small><strong>42</strong></div><div class="stat"><small>Revenue</small><strong>$2,480</strong></div><div class="stat"><small>Rating</small><strong>4.7 ★</strong></div></div>
<div class="section-head"><h2>Recent bulk orders</h2></div><div class="table-wrap"><table class="table"><tr><th>Order</th><th>Business</th><th>Items</th><th>Value</th><th>Status</th></tr><tr><td>#B2B8821</td><td>FreshMart</td><td>120 cartons</td><td>$1,200</td><td><span class="pill">Preparing</span></td></tr><tr><td>#B2B8819</td><td>ABC Retail</td><td>80 units</td><td>$640</td><td><span class="pill">Dispatched</span></td></tr></table></div>`;

pages.support=()=>`
<div class="section-head"><div><h2>How can we help?</h2><p class="muted">Fast support for orders, payments, delivery and account issues.</p></div></div>
<div class="card"><div class="global-search" style="max-width:none"><span>⌕</span><input placeholder="Search Help Centre..."></div></div>
<div class="support-grid" style="margin-top:18px">${support("📦","My order has a problem")}${support("💳","Payment problem")}${support("🚚","Delivery problem")}${support("🏪","Business complaint")}${support("↩️","Refund request")}${support("⚠️","Report a business")}</div>
<div class="section-head"><h2>Talk to us</h2></div><div class="grid">${support("💬","Live Chat")}${support("📞","Call Support")}${support("🤖","ZimConnect AI Assistant")}</div>`;
function support(icon,title){return `<div class="support-item"><div class="avatar">${icon}</div><h3>${title}</h3><p class="muted">Get help and track your support request.</p><button class="btn secondary" onclick="toast('${title} opened')">Open</button></div>`}

pages.profile=()=>`
<div class="section-head"><div><h2>My Profile</h2><p class="muted">Manage your account and preferences.</p></div></div>
<div class="card"><div class="business-card"><div class="avatar" style="width:70px;height:70px">👤</div><div><h2 style="margin:0">Beryl Mawozvere</h2><p class="muted">Consumer · Harare</p><span class="pill">✓ Phone verified</span> <span class="pill">✓ Email verified</span></div></div></div>
<div class="section-head"><h2>Account</h2></div><div class="grid">${quick("🔐","Security","Change password, OTP and two-factor authentication.")}${quick("📍","Addresses","Manage delivery locations.")}${quick("🎁","ZimPoints","View loyalty points and rewards.")}</div>`;

pages.admin=()=>`
<div class="section-head"><div><h2>🛡️ Admin Control Centre</h2><p class="muted">Monitor the ZimConnect ecosystem.</p></div><span class="pill">System healthy</span></div>
<div class="stat-grid"><div class="stat"><small>Users</small><strong>25,420</strong></div><div class="stat"><small>Businesses</small><strong>3,821</strong></div><div class="stat"><small>Suppliers</small><strong>524</strong></div><div class="stat"><small>Delivery agents</small><strong>1,250</strong></div></div>
<div class="section-head"><h2>Verification queue</h2></div><div class="table-wrap"><table class="table"><tr><th>Application</th><th>Owner</th><th>Documents</th><th>Status</th><th>Action</th></tr><tr><td>ABC Electronics</td><td>Owner verified</td><td>ID + photo + contacts</td><td><span class="pill">Pending review</span></td><td><button class="btn" onclick="toast('Verification opened')">Review</button></td></tr><tr><td>Harare Wholesale Foods</td><td>Owner verified</td><td>Complete</td><td><span class="pill">Verified</span></td><td><button class="btn secondary">View</button></td></tr></table></div>
<div class="section-head"><h2>Platform controls</h2></div><div class="grid">${quick("🏪","Businesses","Approve, reject, suspend and review businesses.")}${quick("💳","Payments","Monitor transactions, refunds and disputes.")}${quick("📢","Advertisements","Review campaigns and performance.")}</div>`;

pages.register=()=>`
<div class="section-head"><div><h2>Register your business</h2><p class="muted">Build trust from the start with strong owner and business verification.</p></div></div>
<div class="card"><div class="stepper"><div class="step active">1 Owner</div><div class="step">2 Documents</div><div class="step">3 Business</div><div class="step">4 Review</div></div>
<div class="form-grid"><div class="field"><label>Full legal name</label><input placeholder="Owner full name"></div><div class="field"><label>National ID number</label><input placeholder="63-1234567-A-45"></div><div class="field"><label>Phone number</label><input placeholder="+263 7X XXX XXXX"></div><div class="field"><label>Email address</label><input placeholder="owner@example.com"></div><div class="field"><label>National ID front</label><input type="file"></div><div class="field"><label>National ID back</label><input type="file"></div><div class="field full"><label>Owner profile photo</label><input type="file" accept="image/*"></div></div><div class="actions"><button class="btn" onclick="fakeAction('Owner details saved')">Continue verification</button></div></div>`;

showPage("home");
