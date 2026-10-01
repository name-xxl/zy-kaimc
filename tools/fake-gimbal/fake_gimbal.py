#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""假云台（Windows WinRT GATT 外设）：广播 CRANE-M2-FAKE，暴露 fee9 服务与智云两个特征。
用途：让 KaiOS 应用连上它，在 PC 端观察 KaiOS 到底发出了什么（以及能否收到通知）。

用法：py tools/fake-gimbal/fake_gimbal.py [--notify 秒]   默认每 5 秒推一条通知
"""
import asyncio
import queue
import sys
import uuid as uuidlib

from winrt.windows.devices.bluetooth.genericattributeprofile import (
    GattServiceProvider, GattServiceProviderAdvertisingParameters,
    GattLocalCharacteristicParameters, GattCharacteristicProperties,
    GattProtectionLevel,
)
from winrt.windows.devices.bluetooth import BluetoothError
from winrt.windows.devices.bluetooth.advertisement import (
    BluetoothLEAdvertisement, BluetoothLEAdvertisementPublisher,
)
from winrt.windows.storage.streams import DataReader, DataWriter

SERVICE = uuidlib.UUID("0000fee9-0000-1000-8000-00805f9b34fb")
CH_WRITE = uuidlib.UUID("d44bc439-abfd-45a2-b575-925416129600")
CH_NOTIFY = uuidlib.UUID("d44bc439-abfd-45a2-b575-925416129601")
ADV_NAME = "CRANE-M2-FAKE"

# 云台对 0x04 的应答（抓包实录），用于自动回包
REPLY_04 = bytes([0x24, 0x3E, 0x08, 0x00, 0x18, 0x12, 0x01, 0x01, 0x04, 0x00, 0xCA, 0x00, 0x69, 0xA8])
NOTIFY_PERIOD = 5.0


def hexs(b):
    return " ".join("%02X" % x for x in b)


def ibuffer_to_bytes(buf):
    try:
        return bytes(memoryview(buf))
    except Exception:
        dr = DataReader.from_buffer(buf)
        arr = bytearray(buf.length)
        dr.read_bytes(arr)
        return bytes(arr)


def bytes_to_ibuffer(b):
    w = DataWriter()
    w.write_bytes(b)
    return w.detach_buffer()


def log(*a):
    print(*a, flush=True)


ECHO_Q = queue.Queue()


def on_write(ch, args):
    def done(op, status):
        try:
            req = op.get_results()
            data = ibuffer_to_bytes(req.value)
            log("[WRITE]", hexs(data))
            try:
                req.respond()
            except Exception:
                pass
            # 自动回包：把收到的智云帧原样回显（dir 改 0x3E），模拟真云台的应答
            if len(data) >= 2 and data[0] == 0x24 and data[1] in (0x3C, 0x3E):
                echo = bytearray(data)
                echo[1] = 0x3E
                ECHO_Q.put(bytes(echo))
        except Exception as e:
            log("[WRITE-err]", repr(e))
    try:
        op = args.get_request_async()
        op.completed = done
    except Exception as e:
        log("[WRITE-err2]", repr(e))


def on_read(ch, args):
    def done(op, status):
        try:
            req = op.get_results()
            req.respond_with_value(bytes_to_ibuffer(bytes([0x01, 0x00])))
        except Exception as e:
            log("[READ-err]", repr(e))
    try:
        op = args.get_read_request_async()
        op.completed = done
    except Exception as e:
        log("[READ-err2]", repr(e))


async def main():
    period = NOTIFY_PERIOD
    if "--notify" in sys.argv:
        period = float(sys.argv[sys.argv.index("--notify") + 1])

    res = await GattServiceProvider.create_async(SERVICE)
    if res.error != BluetoothError.SUCCESS:
        log("create_async 失败:", res.error)
        return
    provider = res.service_provider
    svc = provider.service
    log("服务已创建:", SERVICE)

    pw = GattLocalCharacteristicParameters()
    pw.characteristic_properties = (
        GattCharacteristicProperties.WRITE_WITHOUT_RESPONSE
        | GattCharacteristicProperties.WRITE
    )
    pw.read_protection_level = GattProtectionLevel.PLAIN
    pw.write_protection_level = GattProtectionLevel.PLAIN
    r1 = await svc.create_characteristic_async(CH_WRITE, pw)
    log("写特征:", CH_WRITE, "err=", r1.error)
    ch_w = r1.characteristic
    ch_w.add_write_requested(on_write)

    pn = GattLocalCharacteristicParameters()
    pn.characteristic_properties = GattCharacteristicProperties.NOTIFY
    pn.read_protection_level = GattProtectionLevel.PLAIN
    pn.write_protection_level = GattProtectionLevel.PLAIN
    r2 = await svc.create_characteristic_async(CH_NOTIFY, pn)
    log("通知特征:", CH_NOTIFY, "err=", r2.error)
    ch_n = r2.characteristic
    ch_n.add_read_requested(on_read)

    def subs_changed(sender, args):
        try:
            log("[SUBS] 订阅数:", sender.subscribed_clients.size if hasattr(sender, 'subscribed_clients') else '?')
        except Exception as e:
            log("[SUBS]", repr(e))
    try:
        ch_n.add_subscribed_clients_changed(subs_changed)
    except Exception as e:
        log("[SUBS-hook]", repr(e))

    adv = BluetoothLEAdvertisement()
    adv.local_name = ADV_NAME
    adv.service_uuids.append(SERVICE)
    params = GattServiceProviderAdvertisingParameters()
    params.is_discoverable = True
    params.is_connectable = True
    try:
        pub = BluetoothLEAdvertisementPublisher()
        pub.advertisement.local_name = ADV_NAME          # 就地修改，不能用 = 赋值整个对象
        pub.advertisement.service_uuids.append(SERVICE)
        pub.start()
        log("独立广播器已启动(带名字):", ADV_NAME)
    except Exception as e:
        log("独立广播器启动失败:", repr(e))
    try:
        provider.start_advertising_with_parameters(params)
        log("provider 广播已启动(可连接):", ADV_NAME)
    except Exception as e:
        log("provider 广播失败:", repr(e))
        try:
            provider.start_advertising()
            log("provider 广播已启动(默认参数)")
        except Exception as e2:
            log("provider 默认广播也失败:", repr(e2))

    log("== 等待 KaiOS 连接（Ctrl+C 退出）；每 %.0fs 推一条通知 ==" % period)
    n = 0
    tick = 0.2
    acc = 0.0
    while True:
        await asyncio.sleep(tick)
        acc += tick
        # 优先回显收到的帧（模拟真云台应答），保证 KaiOS 侧马上能收到
        while not ECHO_Q.empty():
            echo = ECHO_Q.get()
            try:
                await ch_n.notify_value_async(bytes_to_ibuffer(echo))
                log("[ECHO]", hexs(echo))
            except Exception as e:
                log("[ECHO-err]", repr(e))
        if acc >= period:
            acc = 0.0
            n += 1
            try:
                subs = ch_n.subscribed_clients
                log("[SUBS] count=%d %s" % (subs.size, [str(s.session.device_id) if hasattr(s, 'session') else '?' for s in subs][:4]))
            except Exception as e:
                log("[SUBS-err]", repr(e))
            frame = bytes([0x24, 0x3E, 0x08, 0x00, 0x18, 0x12, n & 0xFF, 0x10, 0x20, 0xC0, 0x3D, 0x00])  # 假按键帧
            try:
                await ch_n.notify_value_async(bytes_to_ibuffer(frame))
                log("[NOTIFY]", hexs(frame))
            except Exception as e:
                log("[NOTIFY-err]", repr(e))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("退出")
