// ============================================================
// Motor/ESC Controller + Sensor Firmware  (ATmega328P / Uno, 16 MHz)
//
// Drives an ESC over Servo, reads an LSM6DSO accelerometer through the
// sensor FIFO in burst reads, counts a pulse-per-rev RPM signal, and
// streams samples to the host as binary frames over USB serial.
//
// Commands (host -> MCU, ASCII):
//   <int>          throttle in microseconds
//   AUTO_TEST / STOP_TEST
//   THROTTLE_HOLD:<us>,<ms> / STOP_HOLD
//   CONFIG:<min>,<max>      runtime motor range
//   SR:DEFAULT|416|833      sampling mode
//   BAUD:<rate>             runtime UART switch
//   AA:<0-7>                anti-alias corner
//   TIMING:ON|OFF           per-section timing
//
// Telemetry (MCU -> host, BINARY):
//   AA 55 | type(1) | len(1) | payload(len) | crc16_ccitt(2, LE)
//   Type 0x01 payload: seq u16, sample_index u32, t_us u32, dt_us u32,
//   rpm_count u16, rpm_period u16, throttle_us u16, n u8, flags u8,
//   scale_code u8, odr_code u8, then n x {i16 ax, ay, az} raw counts.
//
// CONTRACT: backend-fastapi/frame_protocol.py is the other half of this
// layout and serial_manager.py matches the ack strings below verbatim.
// Change either side and the other must change with it; test_protocol.py
// parses this file to assert they still agree.
//
// Serial.begin(115200) in setup() must stay a fixed literal matching
// SerialManager.BOOT_BAUD — the two-phase baud handshake depends on the
// board always rebooting to a known rate.
//
// ------------------------------------------------------------
// SRAM DISCIPLINE — READ BEFORE ADDING ANY Serial.print("...")
//
// 2 KB of SRAM, total. On AVR a bare string literal passed to
// Serial.print() is copied into SRAM at startup and stays there forever;
// the ~54 literals here total ~1.2 KB and alone consumed most of it.
//
// EVERY string literal must be wrapped in F(), which keeps it in flash:
//
//   WRONG:  Serial.println("SR applied: 833Hz");
//   RIGHT:  Serial.println(F("SR applied: 833Hz"));
//
// Forgetting F() is NOT a compile error. It silently eats the headroom
// the stack needs, and the failure mode is a run-time stack collision —
// random resets or corrupted samples under load. Flash is only ~50%
// used, so this trade is always worth it.
//
// If SRAM gets tight, the knobs are TX_RING_SIZE (256 -> 192 -> 160;
// hard floor 128, below which a single 126-byte frame no longer fits and
// every frame is dropped) and MAX_BATCH (16 -> 12).
// ============================================================

#include <Servo.h>
#include <Wire.h>
#include <SparkFunLSM6DSO.h>

Servo esc;
LSM6DSO imu;

// ── Firmware identity ────────────────────────────────────────
#define FW_VERSION "v10"

#if defined(__AVR_ATmega328P__)
  #define BOARD_ID "AVR-ATmega328P"
#elif defined(__AVR_ATmega2560__)
  #define BOARD_ID "AVR-ATmega2560"
#elif defined(__AVR_ATmega32U4__)
  #define BOARD_ID "AVR-ATmega32U4-nativeUSB"
#elif defined(ARDUINO_UNOR4_MINIMA) || defined(ARDUINO_UNOR4_WIFI) || defined(_RENESAS_RA_)
  #define BOARD_ID "Renesas-RA4M1-UnoR4-nativeUSB"
#else
  #define BOARD_ID "unknown"
#endif

#define REG_FIFO_CTRL3        0x09
#define REG_FIFO_CTRL4        0x0A
#define REG_CTRL1_XL          0x10
#define REG_CTRL2_G           0x11
#define REG_CTRL3_C           0x12
#define REG_CTRL8_XL          0x17
#define REG_FIFO_STATUS1      0x3A
#define REG_FIFO_STATUS2      0x3B
#define REG_FIFO_DATA_OUT_TAG 0x78

// FIFO word tag for accelerometer data (FIFO_DATA_OUT_TAG >> 3).
#define FIFO_TAG_ACCEL        0x02

// ── Motor throttle range [v4: mutable, set via CONFIG] ───────
int THR_MIN = 1025;   // 0% — below motor start, truly off (default: U15II KV100 @ 48V)
int THR_MAX = 1600;

enum SamplingMode { SR_DEFAULT = 0, SR_416 = 1, SR_833 = 2 };
SamplingMode samplingMode = SR_833;      // [NEW v9] 833 is the new default

const uint16_t ACCEL_ODR_HZ = 833;       // sensor ODR — fixed in v9
uint8_t  outputDecimation   = 1;         // 1 = every sample out (833Hz)
uint32_t outputDtUs         = 1200;      // nominal output period, us
uint8_t  decimateCounter    = 0;

#define DECIM_DEFAULT 167

uint8_t aaCode = 0;   // default ODR/4 = 208Hz at 833Hz ODR

#define DEBOUNCE_NUM 3
#define DEBOUNCE_DEN 8

#define DEBOUNCE_MIN_US   800UL
#define DEBOUNCE_MAX_US 60000UL

#define DEBOUNCE_BOOTSTRAP_US 3000UL

volatile unsigned long pulseDebounceUs = DEBOUNCE_BOOTSTRAP_US;

#define I2C_FAST_MODE 1   // 1 = 400kHz (current), 0 = 100kHz (diagnostic)

volatile int           pulseCount    = 0;
volatile unsigned long lastPulseTime = 0;

volatile unsigned long minInterval   = 0xFFFFFFFFUL;
volatile unsigned long maxInterval   = 0;

#define RPM_LOG_SLOTS 32
volatile uint16_t intervalLog[RPM_LOG_SLOTS];
volatile uint8_t  intervalLogCount = 0;

unsigned long lastRPMTime = 0;
float    rpm        = 0;    // count-based (historical definition)
uint16_t rpmPeriod  = 0;    // [v10] median-based

const unsigned long RPM_GUARD_MS  = 3;
const unsigned long RPM_GUARD_US  = 3000UL;
unsigned long i2cQuietUntilUs = 0;

static inline bool timeReached(unsigned long now, unsigned long deadline) {
  return (long)(now - deadline) >= 0;
}

// ── Throttle ─────────────────────────────────────────────────
int throttle = THR_MIN;

unsigned long lastServoWriteUs = 0;
const unsigned long SERVO_WRITE_PERIOD_US = 20000UL;

bool autoTestRunning = false;

int PAUSE_POINTS[9];
const int NUM_PAUSES              = 9;
const unsigned long PAUSE_HOLD_MS = 3000UL;

const unsigned long RAMP_UP_TOTAL_MS = 70000UL;
const unsigned long RAMP_DOWN_MS     = 15000UL;
const unsigned long TOTAL_PAUSE_MS   = (unsigned long)NUM_PAUSES * PAUSE_HOLD_MS;
const unsigned long NET_RAMP_UP_MS   = RAMP_UP_TOTAL_MS - TOTAL_PAUSE_MS;

int SEG_START[10];
int SEG_END[10];
const int NUM_SEGS    = 10;
int TOTAL_RANGE = THR_MAX - THR_MIN;

int  atPhase    = 0;
int  atSegIdx   = 0;
bool atInPause  = false;
unsigned long atSegStart      = 0;
unsigned long atPauseStart    = 0;
unsigned long atRampDownStart = 0;

bool throttleHoldRunning = false;

int           throttleHoldTarget = 0;
unsigned long throttleHoldMs     = 0;
const int     THR_RAMP_RATE      = 5;

int thPhase = 0;
unsigned long thHoldStart    = 0;
unsigned long thLastRampTick = 0;

void resetThrottleHold() {
  throttleHoldRunning = false;
  thPhase             = 0;
  thHoldStart         = 0;
  thLastRampTick      = 0;
}

#define TX_RING_SIZE 256
uint8_t  txRing[TX_RING_SIZE];
uint16_t txHead = 0;   // write index
uint16_t txTail = 0;   // read index
uint16_t txUsed = 0;

static inline uint16_t txFree() { return TX_RING_SIZE - txUsed; }

static inline void txPushByte(uint8_t b) {
  txRing[txHead] = b;
  txHead = (txHead + 1) % TX_RING_SIZE;
  txUsed++;
}

// Push as much as the UART will take right now, without blocking.
static void txDrain() {
  int room = Serial.availableForWrite();
  while (txUsed > 0 && room > 0) {
    Serial.write(txRing[txTail]);
    txTail = (txTail + 1) % TX_RING_SIZE;
    txUsed--;
    room--;
  }
}

static uint16_t crc16Update(uint16_t crc, uint8_t b) {
  crc ^= (uint16_t)b << 8;
  for (uint8_t i = 0; i < 8; i++) {
    crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

// ── Telemetry framing state ──────────────────────────────────
#define FRAME_TYPE_TELEMETRY 0x01
#define TELEMETRY_HEADER_LEN 24
#define MAX_BATCH            16

uint16_t frameSeq     = 0;
uint32_t sampleIndex  = 0;   // absolute count of samples EMITTED since boot
uint8_t  pendingFlags = 0;   // sticky until reported in the next frame

#define FLAG_FIFO_OVERRUN   0x01
#define FLAG_TX_DROP        0x02
#define FLAG_TAG_FALLBACK   0x04

// Batch staging — raw int16 counts, filled from the FIFO burst read.
int16_t batchBuf[MAX_BATCH * 3];
uint8_t batchCount = 0;

// ── [NEW v9] P0 timing instrumentation (RESEARCH.md §17.2) ───
bool     timingEnabled  = false;
uint32_t tI2cUs         = 0;   // accumulated microseconds in FIFO reads
uint32_t tEncodeUs      = 0;   // accumulated microseconds in frame encode
uint32_t tSamples       = 0;   // samples covered by the above
unsigned long lastTimingReport = 0;

float gx = 0, gy = 0, gz = 0;

void rpmISR() {
  unsigned long now = micros();
  unsigned long delta = now - lastPulseTime;
  if (delta > pulseDebounceUs) {
    pulseCount++;
    if (lastPulseTime != 0) {
      if (delta < minInterval) minInterval = delta;
      if (delta > maxInterval) maxInterval = delta;
      if (intervalLogCount < RPM_LOG_SLOTS) {
        unsigned long q = delta >> 2;                  // 4us units
        intervalLog[intervalLogCount++] =
            (uint16_t)(q > 65535UL ? 65535UL : q);
      }
    }
    lastPulseTime = now;
  }
}

// ── Helper: AUTO_TEST segment ramp duration ───────────────────
unsigned long segDuration(int idx) {
  int span = SEG_END[idx] - SEG_START[idx];
  return (unsigned long)((float)NET_RAMP_UP_MS * span / TOTAL_RANGE);
}

// [v4] Recalculate PAUSE_POINTS / SEG_START / SEG_END / TOTAL_RANGE.
void recalcProfileArrays() {
  TOTAL_RANGE = THR_MAX - THR_MIN;
  float step = (float)TOTAL_RANGE / NUM_SEGS;

  for (int i = 0; i < NUM_SEGS; i++) {
    SEG_START[i] = THR_MIN + (int)round(i * step);
    SEG_END[i]   = THR_MIN + (int)round((i + 1) * step);
  }
  SEG_END[NUM_SEGS - 1] = THR_MAX;

  for (int i = 0; i < NUM_PAUSES; i++) {
    PAUSE_POINTS[i] = SEG_END[i];
  }
}

void resetAutoTest() {
  autoTestRunning  = false;
  atPhase          = 0;
  atSegIdx         = 0;
  atInPause        = false;
  throttle         = THR_MIN;
}

static bool regUpdate(uint8_t reg, uint8_t mask, uint8_t value) {
  uint8_t v;
  if (imu.readRegister(&v, reg) != IMU_SUCCESS) return false;
  v = (uint8_t)((v & ~mask) | (value & mask));
  return imu.writeRegister(reg, v) == IMU_SUCCESS;
}

// Map a sampling mode to a decimation factor of the fixed 833Hz ODR.
static void applyDecimation(SamplingMode m) {
  switch (m) {
    case SR_416:
      outputDecimation = 2;                    // 833/2 = 416.5 Hz
      break;
    case SR_833:
      outputDecimation = 1;                    // 833 Hz
      break;
    default:
      outputDecimation = DECIM_DEFAULT;        // ~5 Hz, historical
      break;
  }
  outputDtUs      = 1200UL * (uint32_t)outputDecimation;
  decimateCounter = 0;
}

static bool applyAntiAlias(uint8_t code) {
  if (code > 7) return false;
  aaCode = code;
  bool ok = true;
  ok &= regUpdate(REG_CTRL1_XL, 0x02, 0x02);                 // LPF2_XL_EN = 1
  ok &= regUpdate(REG_CTRL8_XL, 0xE4, (uint8_t)(code << 5));  // HPCF_XL, HP_SLOPE=0, FASTSETTL=0
  return ok;
}

static bool startFifo() {
  bool ok = true;
  // FIFO_CTRL3: BDR_GY[7:4] = 0 (gyro not batched), BDR_XL[3:0] = 0x07 (833Hz)
  ok &= (imu.writeRegister(REG_FIFO_CTRL3, 0x07) == IMU_SUCCESS);
  // FIFO_CTRL4: FIFO_MODE[2:0] = 0x06 (continuous)
  ok &= regUpdate(REG_FIFO_CTRL4, 0x07, 0x06);
  return ok;
}

static void stopFifo() {
  regUpdate(REG_FIFO_CTRL4, 0x07, 0x00);   // bypass = FIFO off/cleared
}

// Drain the FIFO by writing bypass then back to continuous. The
// library's fifoClear() is an empty stub, so this is done explicitly.
static void clearFifo() {
  regUpdate(REG_FIFO_CTRL4, 0x07, 0x00);
  regUpdate(REG_FIFO_CTRL4, 0x07, 0x06);
}

void applySamplingMode(SamplingMode m) {
  samplingMode = m;
  applyDecimation(m);
  uint8_t code;
  if (outputDecimation == 1)      code = 0;   // 208 Hz
  else if (outputDecimation == 2) code = 1;   // 83 Hz
  else                            code = 4;   // ~8.3 Hz for the ~5Hz mode
  applyAntiAlias(code);
  clearFifo();
  batchCount      = 0;
  decimateCounter = 0;
}

#define BURST_WORDS 4
uint8_t  burstWords     = BURST_WORDS;
uint16_t tagMismatches  = 0;
#define TAG_MISMATCH_LIMIT 32

const unsigned long FIFO_SERVICE_US = 4000UL;
unsigned long lastFifoServiceUs = 0;

static uint8_t fifoBuf[BURST_WORDS * 7];

// How many unread words the FIFO holds, and whether it overran.
static uint16_t fifoDepth() {
  uint8_t s[2];
  if (imu.readMultipleRegisters(s, REG_FIFO_STATUS1, 2) != IMU_SUCCESS) return 0;
  if (s[1] & 0x40) pendingFlags |= FLAG_FIFO_OVERRUN;   // FIFO_OVR_IA
  return (uint16_t)(((uint16_t)(s[1] & 0x03) << 8) | s[0]);
}

void setup() {
  Serial.begin(115200);
  while (!Serial);

  esc.attach(9);

  pinMode(2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), rpmISR, FALLING);

  Serial.println(F("Initializing IMU..."));
  Wire.begin();
#if I2C_FAST_MODE
  Wire.setClock(400000);
#else
  Wire.setClock(100000);
#endif
  if (!imu.begin()) {
    Serial.println(F("IMU not detected!"));
    while (1);
  }
  imu.initialize(BASIC_SETTINGS);

  // [NEW v9] Sensor configuration, in dependency order.
  imu.setAccelRange(4);                       // ±4g -> 0.122 mg/LSB
  imu.setAccelDataRate(ACCEL_ODR_HZ);         // 833Hz ODR, fixed
  imu.setBlockDataUpdate(true);               // no MSB/LSB tearing
  imu.setIncrement(true);                     // required for burst reads
  imu.writeRegister(REG_CTRL2_G, 0x00);       // gyro powered down (was on, never read)

  delay(2000);

  gx = imu.readFloatAccelX();
  gy = imu.readFloatAccelY();
  gz = imu.readFloatAccelZ();
  Serial.print(F("Gravity reference: "));
  Serial.print(gx, 3); Serial.print(F(","));
  Serial.print(gy, 3); Serial.print(F(","));
  Serial.println(gz, 3);

  applySamplingMode(SR_833);                  // sets decimation + LPF2
  startFifo();

  recalcProfileArrays();

  // ESC arming — DO NOT REMOVE
  Serial.println(F("Arming ESC..."));
  esc.writeMicroseconds(1000);
  delay(8000);
  esc.writeMicroseconds(THR_MIN);
  delay(500);

  Serial.print(F("BOARD=")); Serial.print(BOARD_ID);
  Serial.print(F(" FW=")); Serial.print(FW_VERSION);
  Serial.print(F(" F_CPU=")); Serial.print((unsigned long)F_CPU);
  Serial.print(F(" ODR=")); Serial.print(ACCEL_ODR_HZ);
  Serial.print(F(" AA_CODE=")); Serial.print(aaCode);
  Serial.print(F(" BURST=")); Serial.println(burstWords);

  Serial.println(F("ESC Armed. Commands: throttle µs | AUTO_TEST | STOP_TEST | THROTTLE_HOLD:<us>,<hold_ms> | STOP_HOLD | CONFIG:<min>,<max> | SR:DEFAULT|416|833 | BAUD:<rate> | AA:<0-7> | TIMING:ON|OFF"));
  Serial.print(F("Active profile: THR_MIN=")); Serial.print(THR_MIN);
  Serial.print(F(" THR_MAX=")); Serial.println(THR_MAX);

  lastRPMTime = millis();
}

#define CMD_BUF_SIZE 48
char    cmdBuf[CMD_BUF_SIZE];
uint8_t cmdLen = 0;

bool parseThrottleHold(const char *args) {
  const char *comma = strchr(args, ',');
  if (!comma) return false;
  throttleHoldTarget = atoi(args);
  throttleHoldMs     = (unsigned long)atol(comma + 1);
  if (throttleHoldTarget < THR_MIN || throttleHoldTarget > THR_MAX) return false;
  if (throttleHoldMs <= 0) return false;
  return true;
}

bool parseConfig(const char *args) {
  const char *comma = strchr(args, ',');
  if (!comma) return false;
  int newMin = atoi(args);
  int newMax = atoi(comma + 1);
  if (newMin <= 0 || newMax <= 0) return false;
  if (newMin >= newMax) return false;
  if (newMax - newMin < NUM_SEGS) return false;
  THR_MIN = newMin;
  THR_MAX = newMax;
  return true;
}

static void handleCommand(char *cmd) {
  if (strcmp(cmd, "AUTO_TEST") == 0) {
    resetThrottleHold();
    resetAutoTest();
    autoTestRunning = true;
    atPhase         = 0;
    atSegIdx        = 0;
    atInPause       = false;
    atSegStart      = millis();
    throttle        = THR_MIN;
    Serial.println(F("AUTO_TEST started"));
  }
  else if (strcmp(cmd, "STOP_TEST") == 0) {
    resetAutoTest();
    Serial.println(F("AUTO_TEST stopped"));
  }
  else if (strncmp(cmd, "THROTTLE_HOLD:", 14) == 0) {
    resetAutoTest();
    resetThrottleHold();
    if (parseThrottleHold(cmd + 14)) {
      throttleHoldRunning = true;
      thPhase             = 0;
      thLastRampTick      = millis();
      throttle            = THR_MIN;
      Serial.print(F("THROTTLE_HOLD started: target="));
      Serial.print(throttleHoldTarget);
      Serial.print(F(" µs, hold="));
      Serial.print(throttleHoldMs);
      Serial.println(F("ms"));
    } else {
      Serial.println(F("THROTTLE_HOLD parse error. Format: THROTTLE_HOLD:<us>,<hold_ms>"));
    }
  }
  else if (strcmp(cmd, "STOP_HOLD") == 0) {
    resetThrottleHold();
    throttle = THR_MIN;
    Serial.println(F("THROTTLE_HOLD stopped"));
  }
  else if (strncmp(cmd, "CONFIG:", 7) == 0) {
    resetAutoTest();
    resetThrottleHold();
    if (parseConfig(cmd + 7)) {
      recalcProfileArrays();
      throttle = THR_MIN;
      esc.writeMicroseconds(THR_MIN);
      Serial.print(F("CONFIG applied: THR_MIN="));
      Serial.print(THR_MIN);
      Serial.print(F(" THR_MAX="));
      Serial.println(THR_MAX);
    } else {
      Serial.println(F("CONFIG parse error. Format: CONFIG:<thr_min>,<thr_max>"));
    }
  }
  else if (strncmp(cmd, "SR:", 3) == 0) {
    const char *arg = cmd + 3;
    if (strcmp(arg, "DEFAULT") == 0) {
      applySamplingMode(SR_DEFAULT);
      Serial.println(F("SR applied: DEFAULT (~5Hz output, ODR 833Hz, decimated)"));
    } else if (strcmp(arg, "416") == 0) {
      applySamplingMode(SR_416);
      Serial.println(F("SR applied: 416Hz"));
    } else if (strcmp(arg, "833") == 0) {
      applySamplingMode(SR_833);
      Serial.println(F("SR applied: 833Hz"));
    } else {
      Serial.println(F("SR parse error. Format: SR:DEFAULT | SR:416 | SR:833"));
    }
  }
  else if (strncmp(cmd, "AA:", 3) == 0) {
    int code = atoi(cmd + 3);
    if (code >= 0 && code <= 7 && applyAntiAlias((uint8_t)code)) {
      Serial.print(F("AA applied: code=")); Serial.println(code);
    } else {
      Serial.println(F("AA parse error. Format: AA:<0-7>"));
    }
  }
  // [NEW v9] TIMING:ON|OFF — P0 instrumentation, RESEARCH.md §17.2.
  else if (strncmp(cmd, "TIMING:", 7) == 0) {
    const char *arg = cmd + 7;
    if (strcmp(arg, "ON") == 0) {
      timingEnabled = true;
      tI2cUs = tEncodeUs = tSamples = 0;
      Serial.println(F("TIMING applied: ON"));
    } else if (strcmp(arg, "OFF") == 0) {
      timingEnabled = false;
      Serial.println(F("TIMING applied: OFF"));
    } else {
      Serial.println(F("TIMING parse error. Format: TIMING:ON | TIMING:OFF"));
    }
  }
  else if (strncmp(cmd, "BAUD:", 5) == 0) {
    long newBaud = atol(cmd + 5);
    if (newBaud > 0) {
      Serial.print(F("BAUD applied: "));
      Serial.println(newBaud);
      Serial.flush();
      delay(50);
      Serial.end();
      Serial.begin(newBaud);
      while (!Serial);
      delay(50);
      Serial.println(F("READY"));
      txHead = txTail = txUsed = 0;
      batchCount = 0;
      clearFifo();
    } else {
      Serial.println(F("BAUD parse error. Format: BAUD:<rate>"));
    }
  }
  else {
    int val = atoi(cmd);
    if (val >= THR_MIN && val <= THR_MAX) {
      resetAutoTest();
      resetThrottleHold();
      throttle = val;
    }
  }
}

static void pollSerialCommands() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdLen > 0) {
        cmdBuf[cmdLen] = '\0';
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
    } else if (cmdLen < CMD_BUF_SIZE - 1) {
      cmdBuf[cmdLen++] = c;
    }
    // Overlong lines are truncated rather than overflowing the buffer;
    // the trailing characters are discarded until the next terminator.
  }
}

// ── [NEW v9] Emit one telemetry frame from batchBuf ──────────
static void emitFrame(uint32_t tUs) {
  if (batchCount == 0) return;

  uint8_t  payloadLen = TELEMETRY_HEADER_LEN + (uint8_t)(batchCount * 6);
  uint16_t frameLen   = (uint16_t)payloadLen + 6;   // sync2 + type + len + crc2

  // DROP-WHOLE-FRAME on insufficient room — never write a partial frame.
  if (txFree() < frameLen) {
    pendingFlags |= FLAG_TX_DROP;
    sampleIndex += batchCount;
    batchCount = 0;
    return;
  }

  uint16_t crc = 0xFFFF;

  txPushByte(0xAA);
  txPushByte(0x55);

  uint8_t type = FRAME_TYPE_TELEMETRY;
  txPushByte(type);       crc = crc16Update(crc, type);
  txPushByte(payloadLen); crc = crc16Update(crc, payloadLen);

  // Little-endian helpers, inlined to avoid a scratch buffer.
  #define PUSH8(v)  do { uint8_t _b = (uint8_t)(v); txPushByte(_b); crc = crc16Update(crc, _b); } while (0)
  #define PUSH16(v) do { uint16_t _w = (uint16_t)(v); PUSH8(_w & 0xFF); PUSH8((_w >> 8) & 0xFF); } while (0)
  #define PUSH32(v) do { uint32_t _d = (uint32_t)(v); PUSH8(_d & 0xFF); PUSH8((_d >> 8) & 0xFF); \
                         PUSH8((_d >> 16) & 0xFF); PUSH8((_d >> 24) & 0xFF); } while (0)

  PUSH16(frameSeq);
  PUSH32(sampleIndex);
  PUSH32(tUs);
  PUSH32(outputDtUs);
  PUSH16((uint16_t)(rpm < 0 ? 0 : (rpm > 65535.0f ? 65535 : (uint16_t)rpm)));
  PUSH16(rpmPeriod);
  PUSH16((uint16_t)throttle);
  PUSH8(batchCount);
  PUSH8(pendingFlags);
  PUSH8(4);                                  // scale_code: ±4g
  PUSH8((uint8_t)(ACCEL_ODR_HZ / 10));       // odr_code: 83 => 833Hz

  for (uint8_t i = 0; i < batchCount * 3; i++) {
    PUSH16((uint16_t)batchBuf[i]);
  }

  #undef PUSH8
  #undef PUSH16
  #undef PUSH32

  txPushByte((uint8_t)(crc & 0xFF));
  txPushByte((uint8_t)((crc >> 8) & 0xFF));

  frameSeq++;
  sampleIndex += batchCount;
  pendingFlags = 0;         // reported — clear the sticky flags
  batchCount   = 0;
}

// ── [NEW v9] Drain the FIFO into batchBuf, emitting frames ───
static void serviceFifo() {
  uint16_t depth = fifoDepth();
  if (depth == 0) return;

  // Bound the work done per loop() call so motor control and command
  // parsing stay responsive even if a large backlog has accumulated.
  uint8_t budget = burstWords * 2;

  while (depth > 0 && budget > 0) {
    uint8_t want = (uint8_t)(depth < burstWords ? depth : burstWords);
    if (want > budget) want = budget;

    uint32_t t0 = timingEnabled ? micros() : 0;
    if (imu.readMultipleRegisters(fifoBuf, REG_FIFO_DATA_OUT_TAG,
                                  (uint8_t)(want * 7)) != IMU_SUCCESS) {
      return;
    }
    if (timingEnabled) tI2cUs += (micros() - t0);

    uint32_t tEnc0 = timingEnabled ? micros() : 0;

    for (uint8_t w = 0; w < want; w++) {
      uint8_t *word = &fifoBuf[w * 7];
      uint8_t  tag  = (uint8_t)(word[0] >> 3);

      if (tag != FIFO_TAG_ACCEL) {
        tagMismatches++;
        if (burstWords > 1 && tagMismatches > TAG_MISMATCH_LIMIT) {
          burstWords    = 1;
          pendingFlags |= FLAG_TAG_FALLBACK;
          clearFifo();
          return;
        }
        continue;
      }

      if (++decimateCounter < outputDecimation) continue;
      decimateCounter = 0;

      int16_t *dst = &batchBuf[batchCount * 3];
      dst[0] = (int16_t)((uint16_t)word[1] | ((uint16_t)word[2] << 8));
      dst[1] = (int16_t)((uint16_t)word[3] | ((uint16_t)word[4] << 8));
      dst[2] = (int16_t)((uint16_t)word[5] | ((uint16_t)word[6] << 8));
      batchCount++;

      if (batchCount >= MAX_BATCH) emitFrame(micros());
    }

    if (timingEnabled) {
      tEncodeUs += (micros() - tEnc0);
      tSamples  += want;
    }

    depth  -= want;
    budget -= want;
  }
}

void loop() {

  // ── Serial command input ────────────────────────────────────
  pollSerialCommands();

  // ── AUTO TEST logic ──────────────────────────────────────────
  if (autoTestRunning) {
    unsigned long now = millis();

    if (atPhase == 0) {
      if (atSegIdx >= NUM_SEGS) {
        atPhase         = 1;
        atRampDownStart = now;
        throttle        = THR_MAX;
      }
      else if (atInPause) {
        throttle = PAUSE_POINTS[atSegIdx - 1];
        if (now - atPauseStart >= PAUSE_HOLD_MS) {
          atInPause  = false;
          atSegStart = now;
        }
      }
      else {
        unsigned long segMs   = segDuration(atSegIdx);
        unsigned long elapsed = now - atSegStart;
        if (elapsed >= segMs) {
          throttle = SEG_END[atSegIdx];
          atSegIdx++;
          if (atSegIdx < NUM_SEGS) {
            atInPause    = true;
            atPauseStart = now;
          }
        } else {
          float pct = (float)elapsed / segMs;
          throttle = SEG_START[atSegIdx] + (int)(pct * (SEG_END[atSegIdx] - SEG_START[atSegIdx]));
        }
      }
    }
    else if (atPhase == 1) {
      unsigned long t2 = now - atRampDownStart;
      if (t2 >= RAMP_DOWN_MS) {
        resetAutoTest();
        Serial.println(F("AUTO_TEST complete"));
      } else {
        float pct = 1.0f - (float)t2 / RAMP_DOWN_MS;
        throttle = THR_MIN + (int)(pct * (THR_MAX - THR_MIN));
      }
    }
  }

  // ── THROTTLE HOLD logic ─────────────────────────────────────
  if (throttleHoldRunning) {
    unsigned long now = millis();

    if (thPhase == 0) {
      if (throttle >= throttleHoldTarget) {
        throttle    = throttleHoldTarget;
        thPhase     = 1;
        thHoldStart = now;
        Serial.print(F("THROTTLE_HOLD: target reached at "));
        Serial.print(throttle);
        Serial.println(F(" µs — holding"));
      } else {
        if (now - thLastRampTick >= 100) {
          thLastRampTick = now;
          throttle += THR_RAMP_RATE;
          if (throttle > throttleHoldTarget) throttle = throttleHoldTarget;
        }
      }
    }
    else if (thPhase == 1) {
      throttle = throttleHoldTarget;
      if (now - thHoldStart >= throttleHoldMs) {
        thPhase        = 2;
        thLastRampTick = now;
        Serial.println(F("THROTTLE_HOLD: hold complete, ramping down"));
      }
    }
    else if (thPhase == 2) {
      if (throttle <= THR_MIN) {
        throttle = THR_MIN;
        resetThrottleHold();
        Serial.println(F("THROTTLE_HOLD complete"));
      } else {
        if (now - thLastRampTick >= 100) {
          thLastRampTick = now;
          throttle -= THR_RAMP_RATE;
          if (throttle < THR_MIN) throttle = THR_MIN;
        }
      }
    }
  }

  // Apply throttle — [v7] rate-limited to the ESC's real 50Hz refresh.
  unsigned long nowServoUs = micros();
  if (nowServoUs - lastServoWriteUs >= SERVO_WRITE_PERIOD_US) {
    lastServoWriteUs = nowServoUs;
    esc.writeMicroseconds(throttle);
  }

  // ── RPM calculation (500ms window) ──────────────────────────
  unsigned long currentTime = millis();

  // [v8] Pre-guard: quiet I2C a few ms BEFORE the window is due to fire.
  if (currentTime + RPM_GUARD_MS >= lastRPMTime + 500) {
    unsigned long guardUntil = micros() + RPM_GUARD_US;
    // Wrap-safe "is guardUntil later than i2cQuietUntilUs?"
    if ((long)(guardUntil - i2cQuietUntilUs) > 0) i2cQuietUntilUs = guardUntil;
  }

  if (currentTime - lastRPMTime >= 500) {
    unsigned long windowMs = currentTime - lastRPMTime;
    float dt = windowMs / 1000.0;

    static uint16_t logCopy[RPM_LOG_SLOTS];
    noInterrupts();
    int           pc     = pulseCount;
    unsigned long iMin   = minInterval;
    unsigned long iMax   = maxInterval;
    uint8_t       nLog   = intervalLogCount;
    for (uint8_t i = 0; i < nLog; i++) logCopy[i] = intervalLog[i];
    pulseCount       = 0;
    minInterval      = 0xFFFFFFFFUL;
    maxInterval      = 0;
    intervalLogCount = 0;
    interrupts();

    rpm = (pc * 60.0) / dt;

    if (nLog > 0) {
      for (uint8_t i = 1; i < nLog; i++) {
        uint16_t v = logCopy[i];
        int8_t j = i - 1;
        while (j >= 0 && logCopy[j] > v) { logCopy[j + 1] = logCopy[j]; j--; }
        logCopy[j + 1] = v;
      }
      unsigned long medianUs = (unsigned long)logCopy[nLog / 2] * 4UL;
      if (medianUs > 0) {
        unsigned long r = 60000000UL / medianUs;
        rpmPeriod = (uint16_t)(r > 65535UL ? 65535UL : r);
      }
    } else {
      rpmPeriod = 0;
    }

    if (pc >= 3 && iMax > 0) {
      unsigned long g = (iMax / DEBOUNCE_DEN) * DEBOUNCE_NUM;
      if (g < DEBOUNCE_MIN_US) g = DEBOUNCE_MIN_US;
      if (g > DEBOUNCE_MAX_US) g = DEBOUNCE_MAX_US;
      noInterrupts();
      pulseDebounceUs = g;
      interrupts();
    } else if (pc == 0) {
      noInterrupts();
      pulseDebounceUs = DEBOUNCE_BOOTSTRAP_US;
      interrupts();
    }

    lastRPMTime = currentTime;

    // [v8] Post-guard.
    i2cQuietUntilUs = micros() + RPM_GUARD_US;

    Serial.print(F("DBG_RPM,pulses="));
    Serial.print(pc);
    Serial.print(F(",window_ms="));
    Serial.print(windowMs);
    Serial.print(F(",rpm_count="));
    Serial.print(rpm, 1);
    Serial.print(F(",rpm_period="));
    Serial.print(rpmPeriod);
    Serial.print(F(",min_us="));
    Serial.print(iMin == 0xFFFFFFFFUL ? 0UL : iMin);
    Serial.print(F(",max_us="));
    Serial.print(iMax);
    Serial.print(F(",debounce_us="));
    Serial.println(pulseDebounceUs);
  }

  unsigned long nowFifoUs = micros();
  if (timeReached(nowFifoUs, i2cQuietUntilUs) &&
      timeReached(nowFifoUs, lastFifoServiceUs + FIFO_SERVICE_US)) {
    lastFifoServiceUs = nowFifoUs;
    serviceFifo();
  }

  static unsigned long lastFlushMs = 0;
  if (batchCount > 0 && (currentTime - lastFlushMs) >= 50) {
    lastFlushMs = currentTime;
    emitFrame(micros());
  }

  // Feed the UART whatever it will take right now, without blocking.
  txDrain();

  // ── [NEW v9] P0 timing report (RESEARCH.md §17.2) ────────────
  if (timingEnabled && (currentTime - lastTimingReport) >= 1000) {
    lastTimingReport = currentTime;
    if (tSamples > 0) {
      Serial.print(F("DBG_TIMING,samples="));   Serial.print(tSamples);
      Serial.print(F(",i2c_us_total="));        Serial.print(tI2cUs);
      Serial.print(F(",encode_us_total="));     Serial.print(tEncodeUs);
      Serial.print(F(",i2c_us_per_sample="));   Serial.print((float)tI2cUs / tSamples, 2);
      Serial.print(F(",encode_us_per_sample="));Serial.print((float)tEncodeUs / tSamples, 2);
      Serial.print(F(",burst_words="));         Serial.print(burstWords);
      Serial.print(F(",tag_mismatch="));        Serial.println(tagMismatches);
    }
    tI2cUs = tEncodeUs = tSamples = 0;
  }
}
