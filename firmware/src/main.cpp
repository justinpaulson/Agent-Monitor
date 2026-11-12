// Agent Monitor firmware — ESP32-2424S012C (ESP32-C3 + 1.28" round GC9A01 + CST816 touch).
//
// The Mac daemon sends one JSON line over USB serial every ~2s and on every change:
//   {"s":[["c","d","my-repo",340,48200,5,23]],"u":{"c":[3,5],"x":[9,-1]}}
// s: sessions, each [agent, state, name, workSeconds, tokens, filesChanged, toolCalls]
//   agent: c = Claude, x = Codex
//   state: a = needs attention, w = working, d = done, i = idle
// u: plan usage percent per agent as [week, 5-hour session]; -1 = not available
//
// There is one page per agent. The outer ring is how much of that agent's weekly
// allowance is left and the ring just inside it is how much of the 5-hour
// session is left (when the plan has one). Both start full and drain.
// Swipe left or right to switch agent; tap to step through its sessions.

#include <Arduino.h>
#include <ArduinoJson.h>
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include "logos.h"

// ---- Board wiring -----------------------------------------------------------
static const int PIN_LCD_SCLK = 6;
static const int PIN_LCD_MOSI = 7;
static const int PIN_LCD_CS = 10;
static const int PIN_LCD_DC = 2;
static const int PIN_LCD_BL = 3;
static const int PIN_TOUCH_SDA = 4;
static const int PIN_TOUCH_SCL = 5;
static const int PIN_TOUCH_INT = 0;
static const int PIN_TOUCH_RST = 1;

class Display : public lgfx::LGFX_Device {
  lgfx::Panel_GC9A01 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;
  lgfx::Touch_CST816S _touch;

 public:
  Display() {
    {
      auto cfg = _bus.config();
      cfg.spi_host = SPI2_HOST;
      cfg.spi_mode = 0;
      cfg.freq_write = 40000000;
      cfg.spi_3wire = true;
      cfg.use_lock = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = PIN_LCD_SCLK;
      cfg.pin_mosi = PIN_LCD_MOSI;
      cfg.pin_miso = -1;
      cfg.pin_dc = PIN_LCD_DC;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs = PIN_LCD_CS;
      cfg.pin_rst = -1;
      cfg.pin_busy = -1;
      cfg.panel_width = 240;
      cfg.panel_height = 240;
      cfg.invert = true;
      cfg.readable = false;
      cfg.bus_shared = false;
      _panel.config(cfg);
    }
    {
      auto cfg = _light.config();
      cfg.pin_bl = PIN_LCD_BL;
      cfg.invert = false;
      cfg.freq = 12000;
      cfg.pwm_channel = 1;
      _light.config(cfg);
      _panel.setLight(&_light);
    }
    {
      auto cfg = _touch.config();
      cfg.x_min = 0;
      cfg.x_max = 239;
      cfg.y_min = 0;
      cfg.y_max = 239;
      cfg.pin_int = PIN_TOUCH_INT;
      cfg.pin_rst = PIN_TOUCH_RST;
      cfg.bus_shared = false;
      cfg.i2c_port = 0;
      cfg.i2c_addr = 0x15;
      cfg.pin_sda = PIN_TOUCH_SDA;
      cfg.pin_scl = PIN_TOUCH_SCL;
      cfg.freq = 400000;
      _touch.config(cfg);
      _panel.setTouch(&_touch);
    }
    setPanel(&_panel);
  }
};

// ---- State ------------------------------------------------------------------
struct Session {
  char agent;  // 'c' or 'x'
  char state;  // 'a', 'w', 'd', 'i'
  char name[20];
  int32_t workSeconds;   // time spent working
  int32_t tokens;        // -1 = not known yet
  int16_t filesChanged;
  int16_t toolCalls;
};

struct Rgb {
  uint8_t r, g, b;
};

static const int MAX_SESSIONS = 12;
static const int AGENT_COUNT = 2;
static const char AGENT_IDS[AGENT_COUNT] = {'c', 'x'};
static const uint8_t *AGENT_LOGOS[AGENT_COUNT] = {LOGO_CLAUDE, LOGO_CODEX};
static const Rgb AGENT_LOGO_COLORS[AGENT_COUNT] = {{217, 119, 87}, {255, 255, 255}};
static const Rgb AGENT_ACCENTS[AGENT_COUNT] = {{217, 119, 87}, {25, 195, 160}};

static const uint32_t LINK_TIMEOUT_MS = 10000;
static const uint32_t DETAIL_TIMEOUT_MS = 10000;
static const int SWIPE_MIN_PX = 40;

static Display lcd;
static LGFX_Sprite canvas(&lcd);
static Session sessions[MAX_SESSIONS];
static int sessionCount = 0;
static int usageWeek[AGENT_COUNT] = {-1, -1};
static int usageSession[AGENT_COUNT] = {-1, -1};
static uint32_t lastMessageAt = 0;
static bool everConnected = false;

static int page = 0;          // index into AGENT_IDS
static int detailIndex = -1;  // -1 = summary view, else index within this agent's sessions
static uint32_t detailShownAt = 0;
static bool hadAttention[AGENT_COUNT] = {false, false};

static bool wasTouched = false;
static int32_t touchStartX = 0, touchLastX = 0;

static char lineBuf[2048];
static size_t lineLen = 0;
static bool lineOverflow = false;

// ---- Colours ----------------------------------------------------------------
static const Rgb AMBER = {255, 176, 0};
static const Rgb BLUE = {70, 150, 255};
static const Rgb GREEN = {60, 210, 110};
static const Rgb IDLE_GREY = {110, 110, 122};
static const Rgb TEXT_GREY = {130, 130, 145};
static const Rgb TRACK = {38, 38, 44};
static const Rgb RED = {235, 70, 60};

static uint16_t color(Rgb c, float k = 1.0f) {
  return lcd.color565((uint8_t)(c.r * k), (uint8_t)(c.g * k), (uint8_t)(c.b * k));
}

// 0..1 smooth pulse with the given period.
static float pulse(uint32_t now, uint32_t periodMs) {
  return 0.5f + 0.5f * sinf((float)(now % periodMs) / periodMs * 6.2831853f);
}

static Rgb stateRgb(char state) {
  switch (state) {
    case 'a': return AMBER;
    case 'w': return BLUE;
    case 'd': return GREEN;
    default:  return IDLE_GREY;
  }
}

static const char *stateWord(char state) {
  switch (state) {
    case 'a': return "NEEDS YOU";
    case 'w': return "WORKING";
    case 'd': return "DONE";
    default:  return "IDLE";
  }
}

// ---- Session helpers --------------------------------------------------------
static int countFor(char agent) {
  int n = 0;
  for (int i = 0; i < sessionCount; i++) n += sessions[i].agent == agent;
  return n;
}

// The nth session belonging to an agent, or nullptr.
static const Session *sessionFor(char agent, int n) {
  for (int i = 0; i < sessionCount; i++) {
    if (sessions[i].agent == agent && n-- == 0) return &sessions[i];
  }
  return nullptr;
}

static bool needsAttention(char agent) {
  for (int i = 0; i < sessionCount; i++) {
    if (sessions[i].agent == agent && sessions[i].state == 'a') return true;
  }
  return false;
}

// Jump to an agent's page when it starts waiting on you, unless the page
// being shown is waiting too.
static void followAttention() {
  for (int i = 0; i < AGENT_COUNT; i++) {
    bool now = needsAttention(AGENT_IDS[i]);
    if (now && !hadAttention[i] && !needsAttention(AGENT_IDS[page])) {
      page = i;
      detailIndex = -1;
    }
    hadAttention[i] = now;
  }
}

// ---- Serial protocol --------------------------------------------------------
static void handleLine(const char *line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  JsonArrayConst list = doc["s"];
  if (list.isNull()) return;

  int n = 0;
  for (JsonArrayConst item : list) {
    if (n >= MAX_SESSIONS) break;
    const char *agent = item[0] | "c";
    const char *state = item[1] | "i";
    const char *name = item[2] | "";
    sessions[n].agent = agent[0];
    sessions[n].state = state[0];
    strlcpy(sessions[n].name, name, sizeof(sessions[n].name));
    sessions[n].workSeconds = item[3] | 0;
    sessions[n].tokens = item[4] | -1;
    sessions[n].filesChanged = item[5] | 0;
    sessions[n].toolCalls = item[6] | 0;
    n++;
  }
  sessionCount = n;

  for (int i = 0; i < AGENT_COUNT; i++) {
    const char key[2] = {AGENT_IDS[i], 0};
    usageWeek[i] = doc["u"][key][0] | -1;
    usageSession[i] = doc["u"][key][1] | -1;
  }

  lastMessageAt = millis();
  everConnected = true;
  followAttention();
  if (detailIndex >= countFor(AGENT_IDS[page])) detailIndex = -1;
}

static void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0 && !lineOverflow) {
        lineBuf[lineLen] = 0;
        handleLine(lineBuf);
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineOverflow = true;
    }
  }
}

// ---- Touch ------------------------------------------------------------------
// A sideways drag switches agent; a tap steps through the agent's sessions.
static void readTouch(uint32_t now) {
  int32_t x, y;
  bool touched = lcd.getTouch(&x, &y) > 0;
  if (touched) {
    if (!wasTouched) touchStartX = x;
    touchLastX = x;
  } else if (wasTouched) {
    if (abs(touchLastX - touchStartX) >= SWIPE_MIN_PX) {
      page = (page + 1) % AGENT_COUNT;
      detailIndex = -1;
    } else {
      int count = countFor(AGENT_IDS[page]);
      if (count > 0) {
        detailIndex = detailIndex + 1 >= count ? -1 : detailIndex + 1;
        detailShownAt = now;
      }
    }
  }
  wasTouched = touched;
  if (detailIndex >= 0 && now - detailShownAt > DETAIL_TIMEOUT_MS) detailIndex = -1;
}

// ---- Drawing ----------------------------------------------------------------
static const int CX = 120, CY = 120;

static void centerText(const char *text, int y, const lgfx::IFont *font, uint16_t fg, float size = 1.0f) {
  canvas.setFont(font);
  canvas.setTextSize(size);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(fg);
  canvas.drawString(text, CX, y);
}

// Draws a logo coverage map centred on (cx, cy). The background is always
// black, so scaling the colour by coverage gives smooth edges.
static void drawLogo(const uint8_t *logo, int cx, int cy, Rgb tint) {
  int left = cx - LOGO_SIZE / 2, top = cy - LOGO_SIZE / 2;
  for (int y = 0; y < LOGO_SIZE; y++) {
    for (int x = 0; x < LOGO_SIZE; x++) {
      uint8_t coverage = logo[y * LOGO_SIZE + x];
      if (coverage) canvas.drawPixel(left + x, top + y, color(tint, coverage / 255.0f));
    }
  }
}

// One usage ring: a dim full track with what is left of the allowance drawn
// over it. It starts full and drains back toward 12 o'clock as usage grows.
// A negative value means the number is not known, so only the track is drawn.
static void usageRing(int rOuter, int rInner, int used, uint16_t fg) {
  canvas.fillArc(CX, CY, rOuter, rInner, 0, 360, color(TRACK));
  if (used < 0) return;
  int left = 100 - (used > 100 ? 100 : used);
  if (left <= 0) return;
  canvas.fillArc(CX, CY, rOuter, rInner, -90, -90 + left * 3.6f, left <= 10 ? color(RED) : fg);
}

static void formatDuration(int32_t seconds, char *out, size_t size) {
  if (seconds < 60) snprintf(out, size, "%ds", (int)seconds);
  else if (seconds < 3600) snprintf(out, size, "%dm %02ds", (int)(seconds / 60), (int)(seconds % 60));
  else snprintf(out, size, "%dh %02dm", (int)(seconds / 3600), (int)(seconds % 3600 / 60));
}

static void formatCount(int32_t n, char *out, size_t size) {
  if (n < 1000) snprintf(out, size, "%d", (int)n);
  else if (n < 1000000) snprintf(out, size, "%.1fk", n / 1000.0f);
  else snprintf(out, size, "%.2fM", n / 1000000.0f);
}

static void drawWaiting(uint32_t now) {
  canvas.fillArc(CX, CY, 119, 115, 0, 360, color({120, 120, 140}, 0.25f + 0.5f * pulse(now, 3000)));
  centerText("AGENT MONITOR", 100, &fonts::FreeSansBold9pt7b, color({220, 220, 230}));
  centerText(everConnected ? "lost connection" : "waiting for Mac", 130, &fonts::FreeSans9pt7b, color(TEXT_GREY));
}

static void drawPage(uint32_t now) {
  char agent = AGENT_IDS[page];
  Rgb accent = AGENT_ACCENTS[page];
  int week = usageWeek[page], session = usageSession[page];
  int mine = countFor(agent);

  usageRing(119, 111, week, color(accent));
  if (session >= 0) usageRing(107, 101, session, color(accent, 0.65f));

  const Session *detail = detailIndex >= 0 ? sessionFor(agent, detailIndex) : nullptr;
  if (detail) {
    char pos[16];
    snprintf(pos, sizeof(pos), "%d / %d", detailIndex + 1, mine);
    centerText(pos, 50, &fonts::FreeSans9pt7b, color(TEXT_GREY));
    centerText(detail->name, 76, &fonts::FreeSansBold9pt7b, TFT_WHITE);
    centerText(stateWord(detail->state), 98, &fonts::FreeSansBold9pt7b, color(stateRgb(detail->state)));

    // Session totals: time spent working, tokens, files changed and tool calls.
    char line[40];
    int y = 126;
    uint16_t statColor = color({190, 190, 205});
    if (detail->workSeconds > 0) {
      formatDuration(detail->workSeconds, line, sizeof(line));
      centerText(line, y, &fonts::FreeSans9pt7b, statColor);
      y += 22;
    }
    if (detail->tokens >= 0) {
      char count[16];
      formatCount(detail->tokens, count, sizeof(count));
      snprintf(line, sizeof(line), "%s tokens", count);
      centerText(line, y, &fonts::FreeSans9pt7b, statColor);
      y += 22;
    }
    if (detail->toolCalls > 0) {
      snprintf(line, sizeof(line), "%d %s   %d %s", detail->filesChanged, detail->filesChanged == 1 ? "file" : "files",
               detail->toolCalls, detail->toolCalls == 1 ? "tool" : "tools");
      centerText(line, y, &fonts::FreeSans9pt7b, statColor);
    }
  } else {
    drawLogo(AGENT_LOGOS[page], CX, 56, AGENT_LOGO_COLORS[page]);
    if (mine == 0) {
      centerText("ALL QUIET", 108, &fonts::FreeSansBold9pt7b, color({150, 150, 165}));
      centerText("no sessions", 132, &fonts::FreeSans9pt7b, color({100, 100, 115}));
    } else {
      // Most urgent state present, and how many of this agent's sessions are in it.
      char state = 'i';
      for (const char *p = "awd"; *p; p++) {
        bool found = false;
        for (int i = 0; i < mine; i++) found |= sessionFor(agent, i)->state == *p;
        if (found) {
          state = *p;
          break;
        }
      }
      int matching = 0;
      const Session *first = nullptr;
      for (int i = 0; i < mine; i++) {
        const Session *s = sessionFor(agent, i);
        bool same = state == 'i' ? (s->state != 'a' && s->state != 'w' && s->state != 'd') : s->state == state;
        if (same) {
          if (!first) first = s;
          matching++;
        }
      }

      // A slow, soft glow instead of a flash when something is waiting on you.
      if (state == 'a') canvas.fillArc(CX, CY, 97, 94, 0, 360, color(AMBER, 0.45f + 0.55f * pulse(now, 4000)));

      char number[8];
      snprintf(number, sizeof(number), "%d", matching);
      centerText(number, 96, &fonts::FreeSansBold24pt7b, state == 'a' ? color(AMBER) : TFT_WHITE, 1.2f);
      centerText(stateWord(state), 134, &fonts::FreeSansBold9pt7b, color(stateRgb(state)));
      if (matching == 1 && first) {
        centerText(first->name, 156, &fonts::FreeSans9pt7b, color({170, 170, 185}));
      } else {
        char total[24];
        snprintf(total, sizeof(total), "%d sessions", mine);
        centerText(total, 156, &fonts::FreeSans9pt7b, color({170, 170, 185}));
      }
    }
  }

  char usageText[32] = "";
  // Shown as what is left, to match the rings.
  if (week >= 0 && session >= 0) snprintf(usageText, sizeof(usageText), "wk %d%%   5h %d%%", 100 - week, 100 - session);
  else if (week >= 0) snprintf(usageText, sizeof(usageText), "wk %d%%", 100 - week);
  else if (session >= 0) snprintf(usageText, sizeof(usageText), "5h %d%%", 100 - session);
  if (usageText[0] && !detail) centerText(usageText, 181, &fonts::Font2, color(TEXT_GREY));

  // Page dots; a dot turns amber when that agent is waiting on you.
  for (int i = 0; i < AGENT_COUNT; i++) {
    uint16_t dot = needsAttention(AGENT_IDS[i]) ? color(AMBER) : i == page ? TFT_WHITE : color({70, 70, 80});
    canvas.fillCircle(CX - 7 + i * 14, 203, 3, dot);
  }
}

static void render(uint32_t now) {
  canvas.fillScreen(TFT_BLACK);
  bool linked = everConnected && (now - lastMessageAt < LINK_TIMEOUT_MS);

  bool attention = false, active = false;
  if (linked) {
    for (int i = 0; i < sessionCount; i++) {
      if (sessions[i].state == 'a') attention = true;
      if (sessions[i].state != 'i') active = true;
    }
  }
  lcd.setBrightness(attention ? 255 : active ? 170 : 60);

  if (linked) drawPage(now);
  else drawWaiting(now);
  canvas.pushSprite(0, 0);
}

// ---- Arduino entry points ---------------------------------------------------
void setup() {
  Serial.begin(115200);
  lcd.init();
  lcd.setRotation(0);
  lcd.setBrightness(170);
  canvas.setColorDepth(16);
  if (!canvas.createSprite(240, 240)) {
    // Not enough contiguous RAM for 16-bit colour; fall back to 8-bit.
    canvas.setColorDepth(8);
    canvas.createSprite(240, 240);
  }
}

void loop() {
  static uint32_t lastFrame = 0;
  uint32_t now = millis();
  readSerial();
  readTouch(now);
  if (now - lastFrame >= 50) {
    lastFrame = now;
    render(now);
  }
}
