# Modern UI Redesign - Documentation

## Overview
The Agent UI has been completely redesigned to match modern ChatGPT-like web design patterns. The layout is now cleaner, more organized, and mobile-responsive.

## Major Changes

### 1. **Layout Restructure**
**Old Design:**
- Complex multi-panel sidebar with 8+ collapsible sections
- Cluttered header with too many badges
- Settings mixed into main navigation

**New Design:**
- Clean left sidebar with just chat history (modern ChatGPT style)
- Minimal top bar with only essential status info
- All settings moved to a dedicated modal panel
- Focused chat area in the center

### 2. **Sidebar Redesign**
- **Location:** Left side (collapsed on mobile)
- **Sections:**
  - "New chat" button at top (bright, prominent)
  - "Conversations" section for chat history
  - Settings gear icon ⚙️ in footer
  - Session list with delete buttons on hover

**Features:**
- Click on any conversation to load it
- Hover over session to show delete button
- Active session is highlighted
- Collapsible on desktop (saves ~260px)
- Hidden behind hamburger menu on mobile

### 3. **Top Bar (Header)**
- **Position:** Top of page
- **Contents:**
  - Model name (e.g., "gemini-2.5-flash")
  - Status indicator (idle/running)
  - Context usage badge (e.g., "45k")
  - Hamburger menu button on mobile

### 4. **Chat Area**
- **Clean message display:**
  - User messages: Right-aligned, teal/green background
  - Assistant messages: Left-aligned, dark background
  - Smooth fade-in animations
  - Proper code block formatting
  - Markdown support (bold, italic, links, lists)

- **Empty state:**
  - Centered logo and welcome message
  - 4 example prompts users can click
  - Auto-hides when messages appear

### 5. **Input Area**
- **Bottom bar** with:
  - Full-width input textarea (grows with content)
  - Send button (floating arrow icon ▶)
  - Keyboard shortcuts hint
  - Focus state with accent border

### 6. **Settings Modal** (NEW)
Access via ⚙️ button in sidebar footer

**Organized sections:**

1. **Cloud Model**
   - API key input with save button
   - Model provider dropdown (Gemini, OpenAI, Claude, Azure)

2. **Local Model**
   - Server URL configuration
   - Probe button to detect local models
   - Enable/disable toggle
   - Status indicator

3. **Runtime Settings**
   - Planning Depth slider (1-20 rounds)
   - Context Budget slider (10-200k chars)
   - Response Pacing slider (0-3000ms)
   - Context usage progress bar

4. **File Access**
   - Authorize Folder button
   - Current access status display

5. **Capabilities**
   - Available tools/skills by category
   - Enable/disable toggles

6. **Activity Stats**
   - Rounds count
   - Tool calls count
   - Messages count
   - Context resets count

### 7. **CSS Architecture**

New modular CSS structure in `assets/styles/`:

- `modern-base.css` - Color palette, typography, forms, buttons
- `modern-sidebar.css` - Left navigation sidebar
- `modern-chat.css` - Topbar and chat messages
- `modern-input.css` - Bottom input area
- `modern-modal.css` - Settings modal and dialogs
- `modern-responsive.css` - Mobile breakpoints

All imported from main `styles.css`

### 8. **Color Scheme**

Modern dark theme:
- **Primary background:** `#0f0f0f` (very dark)
- **Secondary background:** `#1a1a1a` (dark card)
- **Text primary:** `#ececf1` (off-white)
- **Text secondary:** `#9a9aa6` (gray)
- **Accent:** `#10a37f` (teal/green, matches OpenAI style)
- **Status colors:** Green (active), Red (error), Blue (info), Amber (warning)

### 9. **Responsive Breakpoints**

- **Desktop (>1024px):** Full layout, wide chat area
- **Tablet (768-1024px):** Adjusted spacing, narrower chat
- **Mobile (<768px):** 
  - Sidebar collapses behind hamburger menu
  - Full-width chat area
  - Touch-optimized buttons (44px minimum)
  - Font size auto-adjusts for readability
- **Small Mobile (<480px):** Compact spacing, minimal badges
- **Landscape mode:** Reduced vertical padding

### 10. **JavaScript Enhancements** (`src/app/ui-modern.js`)

**New Functions:**
- `openSettings()` - Open settings modal
- `closeSettings()` - Close settings modal
- `toggleSidebar()` - Toggle sidebar visibility (improved for mobile)
- `renderSessionList()` - Display chat history
- `renderMessage()` - Render chat messages with proper styling
- `renderToolGroups()` - Display available tools/capabilities
- `formatMarkdown()` - Convert markdown to HTML
- `updateTopbarBadges()` - Update status badges in header
- `updateTopbarStatus()` - Update status indicator
- `initializeModernUI()` - Initialize UI on page load
- `restoreSidebarState()` - Restore sidebar collapse state from localStorage

**Event Handlers:**
- ESC key closes settings modal
- Click outside modal closes it
- Mobile sidebar closes when clicking main content
- Window resize adjusts layout appropriately
- Smooth scroll to new messages

## File Changes Summary

### Modified Files:
- `index.html` - Completely restructured with new layout
- `assets/styles.css` - Updated imports for new CSS files

### New Files:
- `assets/styles/modern-base.css` - Base colors and typography
- `assets/styles/modern-sidebar.css` - Sidebar styling
- `assets/styles/modern-chat.css` - Topbar and chat styling
- `assets/styles/modern-input.css` - Input area styling
- `assets/styles/modern-modal.css` - Settings modal styling
- `assets/styles/modern-responsive.css` - Mobile responsive rules
- `src/app/ui-modern.js` - UI handler functions

### Kept (Unchanged):
- All existing JavaScript logic (state.js, agent.js, tools.js, etc.)
- Skill modules (web.js, filesystem.js, etc.)
- Core orchestrator and LLM handlers

## Keyboard Shortcuts

- **Enter** - Send message
- **Shift+Enter** - New line in message
- **Escape** - Close settings modal
- **Menu/Hamburger** - Toggle sidebar (mobile)

## How to Use

### Starting a New Chat
Click the "**+ New chat**" button in the top-left sidebar

### Accessing Settings
Click the "**⚙️**" settings button at the bottom of the sidebar

### Loading Previous Chats
Click on any chat in the "Conversations" list on the sidebar

### Managing API Keys
1. Click ⚙️ to open settings
2. Go to "Cloud Model" section
3. Enter your API key and click Save
4. Select your preferred model provider

### Configuring Local Models
1. Click ⚙️ to open settings
2. Go to "Local Model" section
3. Enter your local server URL (e.g., http://localhost:1234)
4. Click "Probe" to detect available models
5. Check "Use local model when available" to enable

### Adjusting Runtime Behavior
1. Click ⚙️ to open settings
2. Go to "Runtime" section
3. Adjust sliders for:
   - **Planning Depth:** How many reasoning steps the agent takes
   - **Context Budget:** How much text context to maintain
   - **Response Pacing:** Delay between response chunks (ms)

## Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Performance Improvements

- Reduced CSS file size with modular imports
- Optimized scrolling with `scroll-behavior: smooth`
- Touch-friendly button sizes (44px minimum on mobile)
- Lazy loading of settings modal
- Efficient message rendering with animations

## Accessibility Features

- Proper semantic HTML
- Focus states on all interactive elements
- Color contrast meets WCAG AA standards
- Keyboard navigation support
- ARIA labels on buttons
- Touch target sizes adequate for mobile

## Future Enhancement Ideas

- Dark/Light theme toggle
- Font size adjustment in settings
- Message search across conversations
- Export chat as PDF
- Voice input/output
- Conversation tagging/filtering
- User preferences persistence
- Conversation sharing/collaboration

## Troubleshooting

### Sidebar won't close on mobile?
- Check if you're clicking on interactive elements inside the sidebar
- The sidebar closes when clicking on the main chat area

### Settings modal appears but doesn't close?
- Press ESC key to close
- Or click outside the modal (on the overlay)

### Messages not showing?
- Check browser console for errors
- Ensure JavaScript is enabled
- Try clearing browser cache

### Responsive layout issues?
- Clear browser cache (Ctrl+Shift+Del)
- Check viewport meta tag in HTML
- Try zooming to 100% (Ctrl+0)

## Development Notes

The new UI maintains 100% compatibility with existing backend logic. All changes are front-end only:
- No API changes
- No skill module changes  
- No orchestrator changes
- Pure HTML/CSS/JavaScript refactor

This means you can safely update the UI without affecting agent functionality.
