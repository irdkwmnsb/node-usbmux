import net from "node:net";
import { EventEmitter } from "events";

import plist from "plist";

/**
 * Debugging
 * set with DEBUG=usbmux:* env variable
 *
 * on windows cmd set with: cmd /C "SET DEBUG=usbmux:* && node script.js"
 */
import bug from "debug";
const debug = {
  relay: bug("usbmux:relay"),
  listen: bug("usbmux:listen"),
  connect: bug("usbmux:connect"),
};

type Device = {
  ConnectionType: string;
  DeviceID: DeviceId;
  LocationID: number;
  ProductID: number;
  SerialNumber: string;
};
/**
 * Keep track of connected devices
 *
 * Maps device UDID to device properties, ie:
 * '22226dd59aaac687f555f8521f8ffddac32d394b': {
 *   ConnectionType: 'USB',
 *   DeviceID: 19,
 *   LocationID: 0,
 *   ProductID: 4776,
 *   SerialNumber: '22226dd59aaac687f555f8521f8ffddac32d394b'
 * }
 *
 * Devices are added and removed to this obj only by createListener()
 *
 */
export const devices: Record<string, Device> = {};

/**
 * usbmuxd address
 *
 * OSX usbmuxd listens on a unix socket at /var/run/usbmuxd
 * Windows usbmuxd listens on port 27015
 *
 * libimobiledevice[1] looks like it operates at /var/run/usbmuxd too, but if
 * your usbmuxd is listening somewhere else you'll need to set this manually.
 *
 * [1] github.com/libimobiledevice/usbmuxd
 */
export const address =
  process.platform === "win32"
    ? { port: 27015, family: 4 }
    : { path: "/var/run/usbmuxd" };

/**
 * Exposes methods for dealing with usbmuxd protocol messages (send/receive)
 *
 * The usbmuxd message protocol has 2 versions. V1 doesn't look like its used
 * anymore. V2 is a header + plist format like this:
 *
 * Header:
 *   UInt32LE Length  - is the length of the header + plist (16 + plist.length)
 *   UInt32LE Version - is 0 for binary version, 1 for plist version
 *   UInt32LE Request - is always 8, for plist? from rcg4u/iphonessh
 *   UInt32LE Tag     - is always 1, ? from rcg4u/iphonessh
 *
 * Plist:
 *   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 *     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
 *   <plist version="1.0">
 *     <dict>
 *       <key>MessageType</key>
 *       <string>Listen</string>
 *       <key>ClientVersionString</key>
 *       <string>node-usbmux</string>
 *       <key>ProgName</key>
 *       <string>node-usbmux</string>
 *     </dict>
 *   </plist>
 *
 * References:
 * - https://github.com/rcg4u/iphonessh
 * - https://www.theiphonewiki.com/wiki/Usbmux (binary protocol)
 */

type DeviceId = number;
type UsbMuxPlist =
  | {
      MessageType: "Result";
      Number: number;
    }
  | {
      MessageType: "Attached";
      Number: number;
      Properties: Device;
    }
  | { MessageType: "Detached"; Number: number; DeviceID: DeviceId };

export const protocol = (function () {
  /**
   * Pack a request object into a buffer for usbmuxd
   */
  function pack(payload_obj: plist.PlistValue): Buffer {
    const payload_plist = plist.build(payload_obj);
    const payload_buf = Buffer.from(payload_plist);

    var header = {
      len: payload_buf.length + 16,
      version: 1,
      request: 8,
      tag: 1,
    };

    const header_buf = Buffer.alloc(16);
    header_buf.fill(0);
    header_buf.writeUInt32LE(header.len, 0);
    header_buf.writeUInt32LE(header.version, 4);
    header_buf.writeUInt32LE(header.request, 8);
    header_buf.writeUInt32LE(header.tag, 12);

    return Buffer.concat([header_buf, payload_buf]);
  }

  /**
   * Swap endianness of a 16bit value
   */
  function byteSwap16(val: number) {
    return ((val & 0xff) << 8) | ((val >> 8) & 0xff);
  }

  /**
   * Listen request
   */
  const listen: Buffer = pack({
    MessageType: "Listen",
    ClientVersionString: "node-usbmux",
    ProgName: "node-usbmux",
  });

  /**
   * Connect request
   *
   * Note: PortNumber must be network-endian, so it gets byte swapped here
   */
  function connect(deviceID: DeviceId, port: number): Buffer {
    return pack({
      MessageType: "Connect",
      ClientVersionString: "node-usbmux",
      ProgName: "node-usbmux",
      DeviceID: deviceID,
      PortNumber: byteSwap16(port),
    });
  }

  /**
   * Creates a function that will parse messages from data events
   *
   * net.Socket data events sometimes break up the incoming message across
   * multiple events, making it necessary to combine them. This parser function
   * assembles messages using the length given in the message header and calls
   * the onComplete callback as new messages are assembled. Sometime multiple
   * messages will be within a single data buffer too.
   */
  function makeParser(
    onComplete: (msg: UsbMuxPlist) => void,
  ): (data: Buffer) => void {
    // Store status (remaining message length & msg text) of partial messages
    // across multiple calls to the parse function
    let len: number, msg: string;

    return function parse(data: Buffer) {
      // Check if this data represents a new incoming message or is part of an
      // existing partially completed message
      if (!len) {
        // The length of the message's body is the total length (the first
        // UInt32LE in the header) minus the length of header itself (16)
        len = data.readUInt32LE(0) - 16;
        msg = "";

        // If there is data beyond the header then continue adding data to msg
        data = data.subarray(16);
        if (!data.length) return;
      }

      // Add in data until our remaining length is used up
      var body = data.subarray(0, len);
      msg += body;
      len -= body.length;

      // If msg is finished, convert plist to obj and run callback
      if (len === 0) onComplete(plist.parse(msg) as UsbMuxPlist);

      // If there is any data left over that means there is another message
      // so we need to run this parse fct again using the rest of the data
      data = data.subarray(body.length);
      if (data.length) parse(data);
    };
  }

  // Exposed methods
  return {
    listen: listen,
    connect: connect,
    makeParser: makeParser,
  };
})();

/**
 * Custom usbmuxd error
 *
 * There's no documentation for usbmuxd responses, but I think I've figured
 * out these result numbers:
 * 0 - Success
 * 2 - Device requested isn't connected
 * 3 - Port requested isn't available \ open
 * 5 - Malformed request
 */
export class UsbmuxdError extends Error {
  number: number;

  constructor(message: string, number: number) {
    if (number) {
      message += ", Err #" + number;
    }
    if (number === 2) message += ": Device isn't connected";
    if (number === 3) message += ": Port isn't available or open";
    if (number === 5) message += ": Malformed request";
    super(message);
    if (number) {
      this.number = number;
    }
  }
}

/**
 * Connects to usbmuxd and listens for ios devices
 *
 * This connection stays open, listening as devices are plugged/unplugged and
 * cant be upgraded into a tcp tunnel. You have to start a second connection
 * with connect() to actually make tunnel.
 *
 * @return {net.Socket} - Socket with 2 bolted on events, attached & detached:
 *
 * Fires when devices are plugged in or first found by the listener
 * @event net.Socket#attached
 * @type {string} - UDID
 *
 * Fires when devices are unplugged
 * @event net.Socket#detached
 * @type {string} - UDID
 */
export function createListener(): net.Socket {
  const conn = net.connect(address);
  const req = protocol.listen;

  /**
   * Handle complete messages from usbmuxd
   * @function
   */
  const parse = protocol.makeParser(function onMsgComplete(msg) {
    debug.listen("Response: \n%o", msg);

    // first response always acknowledges / denies the request:
    if (msg.MessageType === "Result" && msg.Number !== 0) {
      conn.emit("error", new UsbmuxdError("Listen failed", msg.Number));
      conn.end();
    }

    // subsequent responses report on connected device status:
    if (msg.MessageType === "Attached") {
      devices[msg.Properties.SerialNumber] = msg.Properties;
      conn.emit("attached", msg.Properties.SerialNumber);
    }

    if (msg.MessageType === "Detached") {
      // given msg.DeviceID, find matching device and remove it
      Object.keys(devices).forEach(function (key) {
        if (devices[key].DeviceID === msg.DeviceID) {
          conn.emit("detached", devices[key].SerialNumber);
          delete devices[key];
        }
      });
    }
  });

  debug.listen("Request: \n%s", req.subarray(16).toString());

  conn.on("data", parse);
  process.nextTick(function () {
    conn.write(req);
  });

  return conn;
}

/**
 * Connects to a device through usbmuxd for a tunneled tcp connection
 */
export function connect(
  deviceID: DeviceId,
  devicePort: number,
): Promise<net.Socket> {
  return new Promise(function (resolve, reject) {
    const conn = net.connect(address),
      req = protocol.connect(deviceID, devicePort);

    /**
     * Handle complete messages from usbmuxd
     * @function
     */
    var parse = protocol.makeParser(function onMsgComplete(msg) {
      debug.connect("Response: \n%o", msg);

      if (msg.MessageType === "Result" && msg.Number === 0) {
        conn.removeListener("data", parse);
        resolve(conn);
        return;
      }

      // anything other response means it failed
      reject(new UsbmuxdError("Tunnel failed", msg.Number));
      conn.end();
    });

    debug.connect("Request: \n%s", req.subarray(16).toString());

    conn.on("data", parse);
    process.nextTick(function () {
      conn.write(req);
    });
  });
}

type RelayOpts = {
  timeout?: number;
  udid?: string;
};
/**
 * Creates a new tcp relay to a port on connected usb device
 *
 * @constructor
 * @param {integer} devicePort          - Port to connect to on device
 * @param {integer} relayPort           - Local port that will listen as relay
 * @param {object}  [opts]              - Options
 * @param {integer} [opts.timeout=1000] - Search time (ms) before warning
 * @param {string}  [opts.udid]         - UDID of specific device to connect to
 *
 * @public
 */
export class Relay extends EventEmitter {
  _devicePort: number;
  _relayPort: number;
  _udid?: string;
  constructor(devicePort: number, relayPort: number, opts: RelayOpts) {
    super();
    this._devicePort = devicePort;
    this._relayPort = relayPort;

    opts = opts || {};
    this._udid = opts.udid;

    this._startListener(opts.timeout || 1000);
    this._startServer();
  }
  /**
   * Stops the relay
   */
  stop = function () {
    this._listener.end();
    this._server.close();
  };
  /**
   * Debugging wrapper for emits
   */
  _emit = function (event: string, data: any) {
    debug.relay("Emit: %s", event + (data ? ", Data: " + data : ""));
    this.emit(event, data);
  };
  /**
   * Starts a usbmuxd listener
   *
   * Relay will start searching for connected devices and issue a warning if a
   * device is not found within the timeout. If/when a device is found, it will
   * emit a ready event.
   *
   * Listener events (attach, detach, error) are passed through as relay events.
   */
  _startListener = function (timeout: number) {
    var _this = this;

    var timer = setTimeout(function () {
      // no UDID was given and no devices found yet
      if (!_this._udid && !Object.keys(devices).length) {
        _this._emit("warning", new Error("No devices connected"));
      }
      // UDID was given, but that device is not connected
      if (_this._udid && !devices[_this._udid]) {
        _this._emit("warning", new Error("Requested device not connected"));
      }
    }, timeout || 1000);

    function readyCheck(udid: string) {
      if (_this._udid && _this._udid !== udid) return;
      _this._emit("ready", udid);
      _this._listener.removeListener("attached", readyCheck);
      clearTimeout(timer);
    }

    this._listener = createListener()
      .on("attached", readyCheck)
      .on("attached", _this._emit.bind(this, "attached"))
      .on("detached", _this._emit.bind(this, "detached"))
      .on("error", _this._emit.bind(this, "error"));
  };
  /**
   * Start local TCP server that will pipe to the usbmuxd tunnel
   *
   * Server events (close and error) are passed through as relay events.
   */
  _startServer = function () {
    var _this = this;
    this._server = net
      .createServer(this._handler.bind(this))
      .on("close", _this._emit.bind(this, "close"))
      .on("error", function (err) {
        _this._listener.end();
        _this._emit("error", err);
      })
      .listen(this._relayPort);
  };
  /**
   * Handle & pipe connections from local server
   *
   * Fires error events and connection begin / disconnect events
   */
  _handler = function (conn: net.Socket) {
    // emit error if there are no devices connected
    if (!Object.keys(devices).length) {
      this._emit("error", new Error("No devices connected"));
      conn.end();
      return;
    }

    // emit error if a udid was specified but that device isn't connected
    if (this._udid && !devices[this._udid]) {
      this._emit("error", new Error("Requested device not connected"));
      conn.end();
      return;
    }

    // Use specified device or choose one from available devices
    var _this = this,
      udid = this._udid || Object.keys(devices)[0],
      deviceID = devices[udid].DeviceID;

    connect(deviceID, this._devicePort)
      .then(function (tunnel) {
        // pipe connection & tunnel together
        conn.pipe(tunnel).pipe(conn);

        _this._emit("connect");

        conn.on("end", function () {
          _this._emit("disconnect");
          tunnel.end();
          conn.end();
        });

        conn.on("error", function () {
          tunnel.end();
          conn.end();
        });
      })
      .catch(function (err) {
        _this._emit("error", err);
        conn.end();
      });
  };
}

/**
 * Find a device (specified or not) within a timeout
 *
 * Usbmuxd has IDs it assigned to devices as they are plugged in. The IDs
 * change as devices are unpplugged and plugged back in, so even if we have a
 * UDID we need to get the current ID from usbmuxd before we can connect.
 */
export function findDevice(opts: RelayOpts): Promise<number> {
  return new Promise(function (resolve, reject) {
    var listener = createListener();
    opts = opts || {};

    var timer = setTimeout(function () {
      listener.end();
      opts.udid
        ? reject(new Error("Requested device not connected"))
        : reject(new Error("No devices connected"));
    }, opts.timeout || 1000);

    listener.on("attached", function (udid) {
      if (opts.udid && opts.udid !== udid) return;
      listener.end();
      clearTimeout(timer);
      resolve(devices[udid].DeviceID);
    });
  });
}

/**
 * Get a tunneled connection to a device (specified or not) within a timeout
 */
export async function getTunnel(
  devicePort: number,
  opts: RelayOpts,
): Promise<net.Socket> {
  opts = opts || {};
  let udid: string;
  let deviceID: DeviceId;

  // If UDID was specified and that device's DeviceID is known, connect to it
  if (opts.udid && devices[opts.udid]) {
    deviceID = devices[opts.udid].DeviceID;
    return connect(deviceID, devicePort);
  }

  // If no UDID given, connect to any known device
  // (random because no key order, but there's probably only 1 option anyways)
  if (!opts.udid && Object.keys(devices).length) {
    udid = Object.keys(devices)[0];
    deviceID = devices[udid].DeviceID;
    return connect(deviceID, devicePort);
  }

  // - Try to find and connect to requested the device (given opts.UDID),
  // - or find and connect to any device (no opts.UDID given)
  const deviceID_2 = await findDevice(opts);
  return await connect(deviceID_2, devicePort);
}
