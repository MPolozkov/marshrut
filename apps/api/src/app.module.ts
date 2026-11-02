import { Controller, Get, Module } from '@nestjs/common';
import { Public } from './common/auth';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from './db/db.module';
import { AuthGuard } from './common/auth';
import { AuthModule } from './auth/auth.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ZonesModule } from './zones/zones.module';
import { CouriersModule } from './couriers/couriers.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { HrModule } from './hr/hr.module';
import { StorageModule } from './common/storage';
import { CompanyModule } from './company/company.module';
import { ReportsModule } from './reports/reports.module';
import { DocumentsModule } from './hr/documents.module';
import { CitiesModule } from './common/cities';
import { WebhooksModule } from './integrations/webhooks';
import { IntegrationsModule } from './integrations/integrations.module';
import { AdminModule } from './admin/admin.module';
import { MailModule } from './common/mail';
import { SupportModule } from './support/support.module';
import { ClientModule } from './client/client.module';
import { OrdersModule } from './orders/orders.module';
import { PushModule } from './push/push.service';
import { TariffsService } from './platform/platform.service';
import { DEFAULT_RATES, VEHICLES } from './common/vehicles';
import { PlatformModule } from './platform/platform.service';
import { PaymentsModule } from './payments/payments.service';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  ok() { return { ok: true, time: new Date().toISOString() }; }
}

/** Как считается сумма заказа и как она делится — для главной страницы. */
@Controller('public/pricing')
class PlansController {
  constructor(private tariffs: TariffsService) {}
  @Public()
  @Get()
  async list() {
    const t = await this.tariffs.forCity('');
    return { feePercent: this.tariffs.feePercent, courierPercent: this.tariffs.sharePercent, nightPercent: t.nightPercent, vehicles: Object.values(VEHICLES).map((v) => ({ ...v, rate: DEFAULT_RATES[v.id] })) };
  }
}

@Module({
  controllers: [HealthController, PlansController],
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' },
    }),
    DbModule, MailModule, PlatformModule, PushModule, PaymentsModule, SupportModule, ClientModule, OrdersModule, StorageModule, WebhooksModule, NotificationsModule, CitiesModule, IntegrationsModule, AdminModule, CompanyModule, ReportsModule, DocumentsModule, AuthModule, ZonesModule, CouriersModule, ShipmentsModule, WarehouseModule, HrModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
